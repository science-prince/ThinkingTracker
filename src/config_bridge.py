"""Standard-library-only configuration bridge. Never emits credentials."""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit, urlunsplit


class ConfigError(Exception):
    pass


def read_config(path: Path):
    raw = path.read_bytes()
    if len(raw) > 4 * 1024 * 1024:
        raise ConfigError("Codex 配置超过安全读取上限。")
    text = raw.decode("utf-8-sig")
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        raise ConfigError("Codex 配置不是有效 TOML；未修改任何内容。") from None
    return raw, text, parsed


def get_path(data, keys):
    for key in keys:
        if not isinstance(data, dict) or key not in data:
            return None
        data = data[key]
    return data


def loopback_url(value):
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "localhost", "::1")
                or url.username or url.password or url.query or url.fragment or not url.port):
            return None
        return url
    except ValueError:
        return None


def url_fields(parsed):
    result = []
    for key in ("openai_base_url", "chatgpt_base_url"):
        if isinstance(parsed.get(key), str):
            result.append(([key], parsed[key]))
    for name, provider in parsed.get("model_providers", {}).items():
        if isinstance(provider, dict) and isinstance(provider.get("base_url"), str):
            result.append((["model_providers", name, "base_url"], provider["base_url"]))
    return result


def db_info(db_path: Path):
    result = {"available": False, "proxy_port": None, "proxy_enabled": False, "providers": []}
    if not db_path.is_file():
        return result
    # mode=ro + query_only prohibit application writes, including updates to settings.
    try:
        with closing(sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)) as db:
            db.execute("PRAGMA query_only=ON")
            db.row_factory = sqlite3.Row
            columns = {r[1] for r in db.execute("PRAGMA table_info(proxy_config)")}
            wanted = [k for k in ("listen_port", "listen_address", "enabled", "proxy_enabled") if k in columns]
            if wanted and "app_type" in columns:
                row = db.execute("SELECT " + ",".join(wanted) + " FROM proxy_config WHERE app_type=?", ("codex",)).fetchone()
                if row:
                    p = dict(row)
                    if p.get("listen_address") in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
                        result["proxy_port"] = p.get("listen_port")
                    result["proxy_enabled"] = bool(p.get("enabled", p.get("proxy_enabled", False)))
            columns = {r[1] for r in db.execute("PRAGMA table_info(providers)")}
            if {"id", "name", "app_type"} <= columns:
                # Deliberately do not SELECT settings_config, auth, meta or notes.
                rows = db.execute("SELECT id,name FROM providers WHERE app_type=?", ("codex",)).fetchall()
                result["providers"] = [{"id": str(r[0])[:160], "name": str(r[1])[:160]} for r in rows[:300]]
            result["available"] = True
    except sqlite3.Error:
        result["error"] = "CCSwitch 数据库暂时不可读；不会写入或修复数据库。"
    return result


def discover(config_path: Path, db_path: Path, proxy_port: int, journal_path: Path):
    _, _, parsed = read_config(config_path)
    db = db_info(db_path)
    journal = load_journal(journal_path)
    old_by_key = {tuple(e["keys"]): e["old"] for e in journal.get("entries", [])}
    fields = []
    candidates = set()
    attached_count = 0
    for keys, value in url_fields(parsed):
        url = loopback_url(value)
        if not url:
            continue
        attached = url.port == proxy_port and tuple(keys) in old_by_key
        original = old_by_key.get(tuple(keys)) if attached else value
        original_url = loopback_url(original)
        matches_cc = bool(original_url and db["proxy_port"] and original_url.port == db["proxy_port"])
        if attached or matches_cc:
            fields.append({"keys": keys, "original": original, "current": value, "attached": attached})
            candidates.add(original_url.port)
            attached_count += int(attached)
    aliases = {}
    catalog_name = parsed.get("model_catalog_json")
    if isinstance(catalog_name, str):
        catalog = Path(catalog_name)
        if not catalog.is_absolute():
            catalog = config_path.parent / catalog
        try:
            if catalog.stat().st_size <= 8 * 1024 * 1024:
                content = json.loads(catalog.read_text("utf-8-sig"))
                for model in content.get("models", [])[:3000]:
                    slug = model.get("slug")
                    if isinstance(slug, str) and "/" in slug:
                        aliases[slug[:200]] = str(model.get("display_name", slug))[:200]
        except (OSError, ValueError, AttributeError, TypeError):
            pass
    return {"config_path": str(config_path), "database": db, "fields": fields,
            "upstream_port": next(iter(candidates)) if len(candidates) == 1 else None,
            "attached": attached_count > 0, "partially_attached": 0 < attached_count < len(fields),
            "configured_effort": parsed.get("model_reasoning_effort"), "aliases": aliases,
            "recovery_pending": bool(journal.get("entries"))}


def load_journal(path):
    if not path.exists():
        return {"version": 1, "entries": []}
    try:
        data = json.loads(path.read_text("utf-8"))
        if data.get("version") != 1 or not isinstance(data.get("entries"), list):
            raise ValueError()
        for entry in data["entries"]:
            if not loopback_url(entry["old"]) or not loopback_url(entry["new"]):
                raise ValueError()
        return data
    except (ValueError, KeyError, TypeError):
        raise ConfigError("恢复记录损坏；请查看恢复说明，程序不会覆盖配置。") from None


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)


def replace_field(text, parsed, keys, value):
    """Locate the exact simple assignment; refuse exotic TOML instead of guessing."""
    section = []
    matches = []
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            try:
                header = tomllib.loads(stripped + "\n__probe_marker__=true")
                section = []
                while isinstance(header, dict) and "__probe_marker__" not in header:
                    if len(header) != 1:
                        raise ValueError()
                    key, header = next(iter(header.items()))
                    section.append(key)
                if not isinstance(header, dict):
                    raise ValueError()
            except (ValueError, tomllib.TOMLDecodeError):
                section = ["__unsupported__"]
        if section != keys[:-1]:
            continue
        pattern = r"^(\s*(?:" + re.escape(keys[-1]) + r"|'" + re.escape(keys[-1]) + r"'|\"" + re.escape(keys[-1]) + r"\")\s*=\s*)(\"(?:[^\"\\\r\n]|\\.)*\"|'[^'\r\n]*')(\s*(?:#[^\r\n]*)?)(\r?\n)?$"
        match = re.match(pattern, line)
        if match:
            try:
                if tomllib.loads("value=" + match[2])["value"] == get_path(parsed, keys):
                    matches.append((index, match))
            except tomllib.TOMLDecodeError:
                pass
    if len(matches) != 1:
        raise ConfigError("地址使用了暂不支持的 TOML 写法；未修改配置，请按文档手动接入。")
    index, match = matches[0]
    lines[index] = match[1] + json.dumps(value, ensure_ascii=False) + match[3] + (match[4] or "")
    result = "".join(lines)
    if get_path(tomllib.loads(result), keys) != value:
        raise ConfigError("地址替换校验失败；未修改配置。")
    return result


def write_checked(path, expected, text):
    # Compare immediately before rename. Other writers do not share our lock, so
    # simultaneous CCSwitch edits remain an explicit limitation in the docs.
    if path.read_bytes() != expected:
        raise ConfigError("Codex 配置正在被其他程序修改；请稍后重试。")
    raw = (b"\xef\xbb\xbf" if expected.startswith(b"\xef\xbb\xbf") else b"") + text.encode("utf-8")
    tomllib.loads(text)
    fd, name = tempfile.mkstemp(prefix=".reasoning-scope-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(raw)
            out.flush()
            os.fsync(out.fileno())
        if path.read_bytes() != expected:
            raise ConfigError("Codex 配置在保存前发生变化；未覆盖新内容。")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def attach(config_path, db_path, proxy_port, journal_path):
    info = discover(config_path, db_path, proxy_port, journal_path)
    if not info["upstream_port"] or not info["database"]["proxy_enabled"]:
        raise ConfigError("未发现已启用的 CCSwitch Codex 本机代理；请先在 CCSwitch 开启 Codex 代理。")
    if info["upstream_port"] == proxy_port:
        raise ConfigError("探测器端口与 CCSwitch 相同，已阻止循环转发。")
    raw, text, parsed = read_config(config_path)
    journal = load_journal(journal_path)
    entries = {tuple(e["keys"]): e for e in journal["entries"]}
    changed = False
    for field in info["fields"]:
        if field["attached"]:
            continue
        keys, old = field["keys"], field["current"]
        url = loopback_url(old)
        new = urlunsplit(("http", f"127.0.0.1:{proxy_port}", url.path, "", ""))
        text = replace_field(text, parsed, keys, new)
        parsed = tomllib.loads(text)
        entries[tuple(keys)] = {"keys": keys, "old": old, "new": new}
        changed = True
    if changed:
        # Commit restoration intent before altering the config; crash-safe ordering.
        atomic_json(journal_path, {"version": 1, "config_path": str(config_path),
                                  "before_sha256": hashlib.sha256(raw).hexdigest(),
                                  "entries": list(entries.values())})
        write_checked(config_path, raw, text)
    return discover(config_path, db_path, proxy_port, journal_path)


def restore(config_path, journal_path):
    journal = load_journal(journal_path)
    if not journal["entries"]:
        return {"restored": 0, "skipped": 0}
    if journal.get("config_path") != str(config_path):
        raise ConfigError("当前 Codex 路径与恢复记录不同；未修改配置。")
    raw, text, parsed = read_config(config_path)
    restored, skipped = 0, 0
    for entry in journal["entries"]:
        if get_path(parsed, entry["keys"]) == entry["new"]:
            text = replace_field(text, parsed, entry["keys"], entry["old"])
            parsed = tomllib.loads(text)
            restored += 1
        else:
            skipped += 1
    if restored:
        write_checked(config_path, raw, text)
    atomic_json(journal_path, {"version": 1, "entries": []})
    return {"restored": restored, "skipped": skipped}


def main():
    if Path(sys.prefix).name.lower() != "selfcontrol":
        raise ConfigError("必须使用 Anaconda 的 selfcontrol 环境。")
    cli = argparse.ArgumentParser()
    cli.add_argument("action", choices=("discover", "attach", "restore"))
    cli.add_argument("--config", required=True)
    cli.add_argument("--database", required=True)
    cli.add_argument("--journal", required=True)
    cli.add_argument("--proxy-port", type=int, required=True)
    args = cli.parse_args()
    config, database, journal = map(Path, (args.config, args.database, args.journal))
    if args.action == "discover":
        result = discover(config, database, args.proxy_port, journal)
    elif args.action == "attach":
        result = attach(config, database, args.proxy_port, journal)
    else:
        result = restore(config, journal)
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ConfigError, OSError, ValueError, KeyError, TypeError) as error:
        message = str(error) if isinstance(error, ConfigError) else "本地配置读取或写入失败；请检查路径、权限和恢复说明。"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        sys.exit(1)
