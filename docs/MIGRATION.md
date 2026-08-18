# Migration to schema v4

Schema v4 intentionally does not read v3 or flattened legacy exports because those files cannot recover discarded lifecycle, context, or control records.

Conversation-turn fields added later are backward compatible within schema v4. Existing `.v4.json` files do not require a bulk migration: the loader derives missing `conversation_turn_id`, `conversation_turn_number`, and `conversation_turn_kind` fields in memory from retained raw records. Reimport only when those derived fields must be persisted in the files themselves.

Rebuild from raw Codex JSONL:

```bash
source .venv/bin/activate
python codex_prettify.py --all --force --replace-v3
```

For each source session the command writes a temporary v4 export, parses it again, atomically installs it, and only then deletes the matching `.v3.json`. A failed conversion leaves v3 untouched. Unmatched v3 files remain on disk but are not listed by the application.

Environment:

```bash
CODEX_SESSIONS_DIR="$HOME/.codex/sessions"
AGENTIC_MAX_INTERACTIONS=5000
DJANGO_DEBUG=true
DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost
```

After migration run `pytest -q`, `python manage.py check`, and inspect at least one large historical session in Turn Lanes and Activity Matrix.
