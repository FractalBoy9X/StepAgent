from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentic_app.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.test import Client  # noqa: E402

HOST = {"HTTP_HOST": "localhost"}


@pytest.fixture(autouse=True)
def empty_codex_sessions_dir(tmp_path, monkeypatch):
    """Keep import actions side-effect free: no real ~/.codex/sessions files."""
    monkeypatch.setenv("CODEX_SESSIONS_DIR", str(tmp_path))


def test_home_lists_sessions() -> None:
    response = Client().get("/", **HOST)
    assert response.status_code == 200
    assert "demo-session.v4.json" in response.content.decode("utf-8")


def test_log_manager_post_redirects_after_import() -> None:
    client = Client()
    response = client.post("/logs/", {"action": "import_all"}, **HOST)
    assert response.status_code == 302
    assert response.url == "/logs/"
    followed = client.get("/logs/", **HOST)
    assert followed.status_code == 200


def test_log_manager_post_unknown_action_still_redirects() -> None:
    response = Client().post("/logs/", {"action": "bogus"}, **HOST)
    assert response.status_code == 302


def test_interaction_api_requires_both_params() -> None:
    response = Client().get("/api/interaction/", **HOST)
    assert response.status_code == 400
    assert "error" in response.json()


def test_graph_api_unknown_file_returns_404() -> None:
    response = Client().get("/api/graph/?file=does-not-exist.v4.json", **HOST)
    assert response.status_code == 404
    assert "error" in response.json()
