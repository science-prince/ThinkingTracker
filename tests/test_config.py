import hashlib
from contextlib import closing
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import config_bridge as bridge


class ConfigurationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.output = ROOT / "test-output"
        self.output.mkdir(exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix="config-fixture-", dir=self.output))
        self.config = self.directory / "config.toml"
        self.db = self.directory / "mock-cc-switch.db"
        self.journal = self.directory / "recovery.json"
        self.original = (
            '# 测试配置，无真实凭据\r\n'
            'model_reasoning_effort = "max"\r\n'
            'openai_base_url = "http://127.0.0.1:15721/v1" # 保留注释\r\n'
            'chatgpt_base_url = "https://example.invalid/backend-api"\r\n'
            '[model_providers.custom]\r\n'
            'base_url = "http://127.0.0.1:15721/v1"\r\n'
            'experimental_bearer_token = "MOCK_CREDENTIAL_NEVER_EMITTED"\r\n'
            '[model_providers.remote]\r\n'
            'base_url = "https://example.invalid/v1"\r\n'
            '[features]\r\n'
            'enabled = true\r\n'
        ).encode("utf-8")
        self.config.write_bytes(self.original)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('CREATE TABLE proxy_config(app_type TEXT,listen_port INTEGER,listen_address TEXT,enabled INTEGER)')
            db.execute('INSERT INTO proxy_config VALUES (?,?,?,?)', ('codex', 15721, '127.0.0.1', 1))
            db.execute('CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT,settings_config TEXT)')
            db.execute('INSERT INTO providers VALUES (?,?,?,?)', ('mock', '模拟来源', 'codex', 'MOCK_DB_SECRET_NEVER_READ'))
            db.commit()
        self.db_before = hashlib.sha256(self.db.read_bytes()).hexdigest()

    def tearDown(self):
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.db_before)
        resolved = self.directory.resolve()
        if not resolved.is_relative_to(self.output.resolve()) or resolved == self.output.resolve():
            raise AssertionError('Fixture cleanup target escaped test-output')
        shutil.rmtree(resolved)

    def attach(self):
        return bridge.attach(self.config, self.db, 18741, self.journal)

    def test_discovery_is_read_only_and_never_emits_credentials(self):
        result = bridge.discover(self.config, self.db, 18741, self.journal)
        self.assertEqual(result['upstream_port'], 15721)
        self.assertFalse(result['attached'])
        self.assertEqual(len(result['fields']), 2)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertNotIn('MOCK_CREDENTIAL', json.dumps(result))
        self.assertNotIn('MOCK_DB_SECRET', json.dumps(result))

    def test_attach_changes_only_ccswitch_urls(self):
        result = self.attach()
        parsed = tomllib.loads(self.config.read_text('utf-8'))
        self.assertTrue(result['attached'])
        self.assertEqual(parsed['openai_base_url'], 'http://127.0.0.1:18741/v1')
        self.assertEqual(parsed['model_providers']['custom']['base_url'], 'http://127.0.0.1:18741/v1')
        self.assertEqual(parsed['chatgpt_base_url'], 'https://example.invalid/backend-api')
        self.assertEqual(parsed['model_providers']['remote']['base_url'], 'https://example.invalid/v1')
        self.assertEqual(parsed['model_reasoning_effort'], 'max')
        self.assertEqual(parsed['model_providers']['custom']['experimental_bearer_token'], 'MOCK_CREDENTIAL_NEVER_EMITTED')
        self.assertIn(b'\r\n', self.config.read_bytes())
        self.assertNotIn('MOCK_CREDENTIAL', self.journal.read_text('utf-8'))

    def test_restore_is_idempotent_and_restores_original_bytes_for_simple_urls(self):
        self.attach()
        self.assertEqual(bridge.restore(self.config, self.journal)['restored'], 2)
        self.assertEqual(self.config.read_bytes(), self.original)
        self.assertEqual(bridge.restore(self.config, self.journal)['restored'], 0)

    def test_repeated_attach_does_not_back_up_the_probe_url_as_original(self):
        self.attach()
        self.attach()
        self.assertEqual(len(bridge.load_journal(self.journal)['entries']), 2)
        bridge.restore(self.config, self.journal)
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_restore_preserves_other_program_edits(self):
        self.attach()
        content = self.config.read_bytes().replace(b'model_reasoning_effort = "max"', b'model_reasoning_effort = "low"')
        self.config.write_bytes(content)
        bridge.restore(self.config, self.journal)
        result = tomllib.loads(self.config.read_text('utf-8'))
        self.assertEqual(result['model_reasoning_effort'], 'low')
        self.assertEqual(result['openai_base_url'], 'http://127.0.0.1:15721/v1')

    def test_restore_skips_addresses_changed_by_ccswitch(self):
        self.attach()
        content = self.config.read_bytes().replace(b'http://127.0.0.1:18741/v1', b'http://127.0.0.1:15799/v1', 1)
        self.config.write_bytes(content)
        result = bridge.restore(self.config, self.journal)
        self.assertEqual(result, {'restored': 1, 'skipped': 1})
        self.assertEqual(tomllib.loads(self.config.read_text('utf-8'))['openai_base_url'], 'http://127.0.0.1:15799/v1')

    def test_attach_does_not_touch_non_loopback_urls(self):
        self.config.write_bytes(self.original.replace(b'http://127.0.0.1:15721/v1', b'https://example.invalid:15721/v1'))
        before = self.config.read_bytes()
        with self.assertRaises(bridge.ConfigError): self.attach()
        self.assertEqual(self.config.read_bytes(), before)

    def test_no_loopback_url_with_credentials_or_query_is_accepted(self):
        for value in ['http://key@127.0.0.1:15721/v1', 'http://127.0.0.1:15721/v1?key=SECRET',
                      'https://127.0.0.1:15721/v1']:
            self.assertIsNone(bridge.loopback_url(value))

    def test_same_proxy_port_blocks_recursion(self):
        with self.assertRaises(bridge.ConfigError):
            bridge.attach(self.config, self.db, 15721, self.journal)
        self.assertEqual(self.config.read_bytes(), self.original)

    def test_wrong_config_path_cannot_use_a_journal(self):
        self.attach()
        other = self.directory / 'other.toml'
        other.write_bytes(self.original)
        with self.assertRaises(bridge.ConfigError): bridge.restore(other, self.journal)
        self.assertEqual(other.read_bytes(), self.original)

    def test_write_checks_external_changes(self):
        self.config.write_bytes(self.original + b'\r\n# concurrent edit\r\n')
        with self.assertRaises(bridge.ConfigError): bridge.write_checked(self.config, self.original, 'key=1\n')
        self.assertIn(b'concurrent edit', self.config.read_bytes())

    def test_crash_after_journal_before_config_is_recoverable(self):
        with patch.object(bridge, 'write_checked', side_effect=bridge.ConfigError('mock crash')):
            with self.assertRaises(bridge.ConfigError): self.attach()
        self.assertEqual(self.config.read_bytes(), self.original)
        result = bridge.restore(self.config, self.journal)
        self.assertEqual(result, {'restored': 0, 'skipped': 2})
        self.assertEqual(bridge.load_journal(self.journal)['entries'], [])

    def test_unsupported_inline_toml_is_refused(self):
        self.config.write_text('model_providers={custom={base_url="http://127.0.0.1:15721/v1"}}\n', encoding='utf-8')
        before = self.config.read_bytes()
        with self.assertRaises(bridge.ConfigError): self.attach()
        self.assertEqual(self.config.read_bytes(), before)

    def test_quoted_provider_ids_are_supported(self):
        self.config.write_text('[model_providers."my.provider"]\nbase_url = \'http://localhost:15721/v1\'\n', encoding='utf-8')
        self.attach()
        self.assertEqual(tomllib.loads(self.config.read_text('utf-8'))['model_providers']['my.provider']['base_url'], 'http://127.0.0.1:18741/v1')
        bridge.restore(self.config, self.journal)
        self.assertEqual(tomllib.loads(self.config.read_text('utf-8'))['model_providers']['my.provider']['base_url'], 'http://localhost:15721/v1')

    def test_bom_and_comments_are_preserved(self):
        self.config.write_bytes(b'\xef\xbb\xbf' + self.original)
        self.attach()
        self.assertTrue(self.config.read_bytes().startswith(b'\xef\xbb\xbf'))
        bridge.restore(self.config, self.journal)
        self.assertEqual(self.config.read_bytes(), b'\xef\xbb\xbf' + self.original)

    def test_invalid_toml_is_never_overwritten(self):
        self.config.write_bytes(b'not valid = [[[')
        with self.assertRaises(bridge.ConfigError): self.attach()
        self.assertEqual(self.config.read_bytes(), b'not valid = [[[')

    def test_corrupted_journal_is_not_silently_discarded(self):
        self.journal.write_text('{broken', encoding='utf-8')
        with self.assertRaises(bridge.ConfigError): self.attach()
        self.assertEqual(self.config.read_bytes(), self.original)


if __name__ == '__main__':
    unittest.main()
