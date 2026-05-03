#!/usr/bin/env python3
import base64
import json
import os
import re
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

WORK_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}

# For these tools, drop large content fields from the logged input — the file
# path is enough for the story; the actual bytes live in git / on disk.
FILE_OP_REDACT = {
    "Write": ("content",),
    "Edit": ("old_string", "new_string"),
    "MultiEdit": ("edits",),
    "NotebookEdit": ("new_source",),
}

# Any string value in a tool_use input longer than this is truncated (catches
# huge Bash heredocs, long regex patterns, etc).
INPUT_STR_MAX = 400

DEFAULT_SCREENSHOT_TOOL = os.environ.get(
    "JOURNAL_SCREENSHOT_TOOL",
    "mcp__iwsdk-runtime__browser_screenshot",
)

# Tool-result text truncation. Keep enough context for the story without bloating.
TOOL_RESULT_HEAD = 1500
TOOL_RESULT_TAIL = 300

CHECKPOINT_PROMPT = """\
Before you stop, capture a checkpoint screenshot from inside VR that frames the
work you just did. The journal hook will save the image to disk automatically —
you do not need to write the file yourself.

Workflow (use the iwsdk-runtime XR tools to pilot the headset and frame the shot):

  1. Enter XR if not already in a session:
       mcp__iwsdk-runtime__xr_get_session_status
       mcp__iwsdk-runtime__xr_accept_session   (only if no active session)

  2. Identify the scene object that represents the work you just did. Use any of:
       mcp__iwsdk-runtime__scene_get_hierarchy        (find by name, get UUID)
       mcp__iwsdk-runtime__ecs_find_entities          (find by component / regex)
       mcp__iwsdk-runtime__ecs_query_entity           (read component values)
       mcp__iwsdk-runtime__scene_get_object_transform (get positionRelativeToXROrigin)

  3. Pilot the headset to a vantage point and orient it at the subject:
       mcp__iwsdk-runtime__xr_set_transform   (snap headset to a pose)
       mcp__iwsdk-runtime__xr_animate_to      (smoothly fly the headset there)
       mcp__iwsdk-runtime__xr_look_at         (aim at a world position; can also move-to)
       mcp__iwsdk-runtime__xr_get_transform   (verify pose)

     Pass positionRelativeToXROrigin from scene_get_object_transform to xr_look_at.
     Take a couple of test shots while framing if you need to — extras are fine,
     all screenshots are persisted as checkpoints.

  4. From inside VR, with the subject framed, capture:
       %(tool)s

  5. After the screenshot returns, stop normally. This hook will not block again
     in this stop chain.
""" % {"tool": DEFAULT_SCREENSHOT_TOOL}


# ---------- helpers ----------

def iso_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def safe_id(s):
    return re.sub(r"[^A-Za-z0-9_-]", "_", s or "x")[:32]


def truncate_text(s):
    n = len(s)
    if n <= TOOL_RESULT_HEAD + TOOL_RESULT_TAIL + 64:
        return s, False
    head = s[:TOOL_RESULT_HEAD]
    tail = s[-TOOL_RESULT_TAIL:]
    middle = "\n...[truncated %d chars]...\n" % (n - TOOL_RESULT_HEAD - TOOL_RESULT_TAIL)
    return head + middle + tail, True


def shrink_input(tool_name, value):
    """Drop file-op payload fields; truncate long string values elsewhere."""
    if not isinstance(value, dict):
        return value
    redact_fields = set(FILE_OP_REDACT.get(tool_name, ()))
    out = {}
    for k, v in value.items():
        if k in redact_fields:
            if isinstance(v, str):
                out[k] = "<redacted %d chars>" % len(v)
            elif isinstance(v, list):
                out[k] = "<redacted %d items>" % len(v)
            else:
                out[k] = "<redacted>"
        elif isinstance(v, str) and len(v) > INPUT_STR_MAX:
            out[k] = v[:INPUT_STR_MAX] + "...[truncated %d chars]" % (len(v) - INPUT_STR_MAX)
        else:
            out[k] = v
    return out


def extract_tool_result(block):
    """Return (text, has_image, is_error)."""
    is_error = bool(block.get("is_error"))
    raw = block.get("content")
    text_parts = []
    has_image = False
    if isinstance(raw, str):
        text_parts.append(raw)
    elif isinstance(raw, list):
        for sub in raw:
            if not isinstance(sub, dict):
                continue
            t = sub.get("type")
            if t == "text":
                text_parts.append(sub.get("text", ""))
            elif t == "image":
                has_image = True
    return "\n".join(text_parts), has_image, is_error


def is_screenshot_tool(name):
    return bool(name) and "screenshot" in name.lower()


# ---------- transcript I/O ----------

def parse_transcript_slice(path, offset):
    """Read transcript from given offset. Returns (entries, new_offset, reset_performed).

    If the file is smaller than offset (compaction/rotation), parse from the
    start and signal reset so the caller can discard prior state.
    """
    size = path.stat().st_size
    if offset > size:
        offset = 0
        reset = True
    else:
        reset = False
    entries = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                e = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if e.get("isSidechain"):
                continue
            entries.append(e)
        new_offset = f.tell()
    return entries, new_offset, reset


def load_prior_events(journal_path):
    """Load the previously-written journal, minus the rebuild-every-run events."""
    if not journal_path.exists():
        return []
    out = []
    with open(journal_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if e.get("type") in ("session_meta", "hook_decision"):
                continue
            out.append(e)
    return out


def write_journal(events, journal_dir, session_id):
    out = journal_dir / ("session-%s.jsonl" % session_id)
    tmp = out.with_suffix(out.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    os.replace(tmp, out)


def load_state(state_path):
    try:
        return json.loads(state_path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state_path, state):
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    os.replace(tmp, state_path)


# ---------- checkpoint persistence ----------

def find_screenshot_tool_uses(entries):
    out = []
    for e in entries:
        if e.get("type") != "assistant":
            continue
        msg = e.get("message") or {}
        for block in msg.get("content") or []:
            if block.get("type") == "tool_use" and is_screenshot_tool(block.get("name")):
                out.append((e.get("timestamp"), block.get("id")))
    return out


def find_image_for_tool_use(entries, tool_use_id):
    for e in entries:
        if e.get("type") != "user":
            continue
        msg = e.get("message") or {}
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if block.get("type") != "tool_result" or block.get("tool_use_id") != tool_use_id:
                continue
            sub = block.get("content")
            if not isinstance(sub, list):
                continue
            for s in sub:
                if s.get("type") != "image":
                    continue
                src = s.get("source") or {}
                if src.get("type") == "base64" and src.get("data"):
                    return src.get("media_type", "image/png"), src["data"]
    return None


def _rel(path, cwd_path):
    try:
        return str(Path(path).resolve().relative_to(cwd_path.resolve()))
    except ValueError:
        return str(path)


def save_screenshots(entries, checkpoint_dir, session_id, cwd_path):
    """Persist new screenshot results. Returns dict tool_use_id -> relative path."""
    sess_dir = checkpoint_dir / session_id
    sess_dir.mkdir(parents=True, exist_ok=True)

    existing_by_id = {}
    for ext in ("png", "jpg", "jpeg", "webp"):
        for p in sess_dir.glob("*." + ext):
            parts = p.stem.rsplit("_", 1)
            if len(parts) == 2:
                existing_by_id[parts[1]] = p

    saved = {}
    for ts, tool_use_id in find_screenshot_tool_uses(entries):
        if not tool_use_id:
            continue
        sid = safe_id(tool_use_id)
        if sid in existing_by_id:
            saved[tool_use_id] = _rel(existing_by_id[sid], cwd_path)
            continue
        img = find_image_for_tool_use(entries, tool_use_id)
        if not img:
            continue
        media_type, data = img
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(media_type, "png")
        ts_safe = (ts or "unknown").replace(":", "-")
        path = sess_dir / ("%s_%s.%s" % (ts_safe, sid, ext))
        try:
            path.write_bytes(base64.b64decode(data))
        except (ValueError, OSError):
            continue
        saved[tool_use_id] = _rel(path, cwd_path)
    return saved


# ---------- event building ----------

def build_new_events(new_entries, saved_screenshots, pending_tool_calls, state, turn):
    """Turn new raw transcript entries into journal events.

    Mutates `pending_tool_calls` (mapping tool_use_id -> tool_call event) so
    that tool_results from this batch can attach to tool_calls from prior runs.
    Updates `state` with first-seen metadata (model, branch, version, started_at).
    Every emitted event is tagged with the given turn number.
    """
    events = []
    for entry in new_entries:
        ts = entry.get("timestamp")
        etype = entry.get("type")
        msg = entry.get("message") or {}

        # Collect session-wide metadata as we see it.
        if "started_at" not in state and ts:
            state["started_at"] = ts
        if "git_branch" not in state and entry.get("gitBranch"):
            state["git_branch"] = entry["gitBranch"]
        if "claude_code_version" not in state and entry.get("version"):
            state["claude_code_version"] = entry["version"]

        if etype == "user":
            content = msg.get("content")
            is_meta = bool(entry.get("isMeta"))
            if isinstance(content, str):
                if is_meta and CHECKPOINT_PROMPT.strip() in content:
                    events.append({
                        "ts": ts,
                        "turn": turn,
                        "type": "hook_block_feedback",
                        "prompt_id": "checkpoint_v1",
                    })
                else:
                    text, was_truncated = truncate_text(content)
                    evt = {
                        "ts": ts,
                        "turn": turn,
                        "type": "hook_block_feedback" if is_meta else "user_message",
                        "content": text,
                    }
                    if was_truncated:
                        evt["truncated"] = True
                    events.append(evt)
            elif isinstance(content, list):
                for block in content:
                    if block.get("type") != "tool_result":
                        continue
                    tid = block.get("tool_use_id")
                    text, has_image, is_error = extract_tool_result(block)
                    truncated_text, was_truncated = truncate_text(text)

                    target = pending_tool_calls.pop(tid, None)
                    if target is None:
                        orphan = {
                            "ts": ts,
                            "turn": turn,
                            "type": "tool_result",
                            "tool_use_id": tid,
                        }
                        if truncated_text:
                            orphan["result"] = truncated_text
                        if is_error:
                            orphan["is_error"] = True
                        if has_image:
                            orphan["has_image"] = True
                        if was_truncated:
                            orphan["truncated"] = True
                        if has_image and tid in saved_screenshots:
                            orphan["checkpoint_path"] = saved_screenshots[tid]
                        events.append(orphan)
                    else:
                        target["result_ts"] = ts
                        if truncated_text:
                            target["result"] = truncated_text
                        if is_error:
                            target["is_error"] = True
                        if has_image:
                            target["has_image"] = True
                        if was_truncated:
                            target["truncated"] = True
                        if has_image and tid in saved_screenshots:
                            target["checkpoint_path"] = saved_screenshots[tid]
            continue

        if etype == "assistant":
            if "model" not in state:
                m = msg.get("model")
                if m:
                    state["model"] = m
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                btype = block.get("type")
                if btype == "text":
                    events.append({
                        "ts": ts,
                        "turn": turn,
                        "type": "assistant_text",
                        "content": block.get("text", ""),
                    })
                elif btype == "tool_use":
                    tool_name = block.get("name")
                    tid = block.get("id")
                    evt = {
                        "ts": ts,
                        "turn": turn,
                        "type": "tool_call",
                        "tool": tool_name,
                        "tool_use_id": tid,
                        "input": shrink_input(tool_name, block.get("input", {})),
                    }
                    events.append(evt)
                    if tid:
                        pending_tool_calls[tid] = evt
                # 'thinking' blocks dropped — Claude Code stores only the
                # encrypted signature, never plaintext, so there's nothing useful.
    return events


def build_session_meta(state, all_events, session_id, cwd):
    updated_at = state.get("started_at")
    user_messages = 0
    tool_uses = 0
    for e in all_events:
        ts = e.get("ts")
        if ts:
            updated_at = ts
        t = e.get("type")
        if t == "user_message":
            user_messages += 1
        elif t == "tool_call" or t == "tool_result":
            tool_uses += 1
    return {
        "ts": state.get("started_at"),
        "type": "session_meta",
        "session_id": session_id,
        "cwd": cwd,
        "model": state.get("model"),
        "git_branch": state.get("git_branch"),
        "claude_code_version": state.get("claude_code_version"),
        "started_at": state.get("started_at"),
        "updated_at": updated_at,
        "user_messages": user_messages,
        "tool_uses": tool_uses,
    }


def has_work_since_last_screenshot(all_events):
    last_shot = -1
    for i, e in enumerate(all_events):
        if e.get("type") == "tool_call" and is_screenshot_tool(e.get("tool")):
            last_shot = i
    for i, e in enumerate(all_events):
        if i <= last_shot:
            continue
        if e.get("type") == "tool_call" and e.get("tool") in WORK_TOOLS:
            return True
    return False


# ---------- main ----------

def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def _run():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}

    transcript_path = payload.get("transcript_path")
    session_id = payload.get("session_id") or "unknown"
    cwd = payload.get("cwd") or os.getcwd()
    stop_hook_active = bool(payload.get("stop_hook_active"))

    if not transcript_path:
        emit({"suppressOutput": True})
        return
    transcript_path = Path(os.path.expanduser(transcript_path))
    if not transcript_path.exists():
        emit({"suppressOutput": True})
        return

    cwd_path = Path(cwd)
    journal_dir = cwd_path / ".claude" / "journal"
    journal_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_dir = journal_dir / "checkpoints"
    journal_path = journal_dir / ("session-%s.jsonl" % session_id)
    state_path = journal_dir / "state" / ("%s.json" % session_id)

    state = load_state(state_path)
    offset = state.get("transcript_offset")
    first_run = offset is None
    if first_run:
        offset = 0

    new_entries, new_offset, reset = parse_transcript_slice(transcript_path, offset)
    if reset or first_run:
        # Transcript shrank (compaction/rotation) or brand-new schema — start fresh.
        state = {}
        prior_events = []
    else:
        prior_events = load_prior_events(journal_path)

    # Re-attach pending tool_calls from prior runs so this batch's tool_results can pair.
    pending_tool_calls = {
        e["tool_use_id"]: e
        for e in prior_events
        if e.get("type") == "tool_call" and "result_ts" not in e and e.get("tool_use_id")
    }

    saved_screenshots = save_screenshots(new_entries, checkpoint_dir, session_id, cwd_path)

    current_turn = state.get("turn", 1)
    new_events = build_new_events(new_entries, saved_screenshots, pending_tool_calls, state, current_turn)
    all_events = prior_events + new_events

    # Decide whether to block the stop. Computed from the full event stream.
    if stop_hook_active:
        decision = {"action": "allowed", "reason": "stop_hook_active"}
    elif not has_work_since_last_screenshot(all_events):
        decision = {"action": "allowed", "reason": "no work since last checkpoint"}
    else:
        decision = {"action": "blocked", "reason": "checkpoint required", "prompt_id": "checkpoint_v1"}

    output = [build_session_meta(state, all_events, session_id, cwd)]
    output.extend(all_events)
    output.append({"ts": iso_now(), "turn": current_turn, "type": "hook_decision", **decision})
    write_journal(output, journal_dir, session_id)

    state["transcript_offset"] = new_offset
    # A blocked stop keeps the same turn going (Claude continues, hook fires
    # again); an allowed stop ends the turn.
    state["turn"] = current_turn + 1 if decision["action"] == "allowed" else current_turn
    save_state(state_path, state)

    if decision["action"] == "allowed":
        emit({"suppressOutput": True})
    else:
        emit({"decision": "block", "reason": CHECKPOINT_PROMPT})


def main():
    try:
        _run()
    except Exception:
        # Never block Claude because of a hook bug. Log and move on.
        try:
            cwd = os.getcwd()
            log_path = Path(cwd) / ".claude" / "journal" / "hook-errors.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as f:
                f.write("\n----- %s -----\n" % iso_now())
                traceback.print_exc(file=f)
        except Exception:
            pass
        emit({"suppressOutput": True})


if __name__ == "__main__":
    main()
