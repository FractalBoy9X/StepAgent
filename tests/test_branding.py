from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentic_app.settings")

import django  # noqa: E402

django.setup()

from django.test import Client  # noqa: E402

HOST = {"HTTP_HOST": "localhost"}


def test_global_navigation_uses_stepagent_branding() -> None:
    body = Client().get("/", **HOST).content.decode("utf-8")

    assert 'aria-label="StepAgent — Home"' in body
    assert 'class="brand-icon"' in body
    assert 'visualization/stepagent-icon.png' in body
    assert 'class="brand-name">StepAgent</span>' in body
    assert 'visualization/stepagent-favicon.png' in body
    assert "Agentic Session Observatory" not in body


def test_page_titles_use_stepagent_in_both_languages() -> None:
    expected = {
        "/": ("Sessions - StepAgent", "Sesje - StepAgent"),
        "/logs/": ("Import logs - StepAgent", "Import logów - StepAgent"),
        "/instructions/": ("Instructions - StepAgent", "Instrukcje - StepAgent"),
        "/visualization/": ("Session timeline - StepAgent", "Oś czasu sesji - StepAgent"),
    }

    for path, (english_title, polish_title) in expected.items():
        english = Client().get(path, HTTP_ACCEPT_LANGUAGE="en", **HOST).content.decode("utf-8")
        polish = Client().get(path, HTTP_ACCEPT_LANGUAGE="pl", **HOST).content.decode("utf-8")
        assert f"<title>{english_title}</title>" in english
        assert f"<title>{polish_title}</title>" in polish
