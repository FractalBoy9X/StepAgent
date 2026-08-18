from __future__ import annotations

import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "agentic_app.settings")

import django  # noqa: E402

django.setup()

from django.conf import settings  # noqa: E402
from django.test import Client  # noqa: E402
from django.urls import reverse  # noqa: E402

HOST = {"HTTP_HOST": "localhost"}


def test_accept_language_selects_supported_language_with_english_fallback() -> None:
    client = Client()
    polish = client.get("/instructions/", HTTP_ACCEPT_LANGUAGE="pl-PL,pl;q=0.9", **HOST)
    assert polish.status_code == 200
    assert '<html lang="pl">' in polish.content.decode("utf-8")
    assert "Opis obserwatorium 2D" in polish.content.decode("utf-8")

    english = Client().get("/instructions/", HTTP_ACCEPT_LANGUAGE="de-DE,de;q=0.9", **HOST)
    assert english.status_code == 200
    assert '<html lang="en">' in english.content.decode("utf-8")
    assert "2D observatory reference" in english.content.decode("utf-8")


def test_instructions_glossary_anchors_exist_in_both_languages() -> None:
    for accept in ("pl-PL,pl;q=0.9", "en-US,en;q=0.9"):
        body = Client().get("/instructions/", HTTP_ACCEPT_LANGUAGE=accept, **HOST).content.decode("utf-8")
        for anchor in ("reading-guide", "views", "families", "kinds", "lifecycle", "selection", "import", "api"):
            assert f'id="{anchor}"' in body
        assert body.count("family-swatch") == 14


def test_language_switch_sets_cookie_and_preserves_full_path() -> None:
    client = Client()
    target = "/visualization/?file=demo-session.v4.json"
    response = client.post(
        reverse("set_language"),
        {"language": "pl", "next": target},
        **HOST,
    )
    assert response.status_code == 302
    assert response.url == target
    assert response.cookies[settings.LANGUAGE_COOKIE_NAME].value == "pl"

    translated = client.get(target, **HOST)
    body = translated.content.decode("utf-8")
    assert translated.status_code == 200
    assert '<html lang="pl">' in body
    assert "Pasy tur" in body
    assert "Macierz aktywności" in body
    assert "Tury konwersacyjne" in body


def test_javascript_catalog_contains_polish_visualization_labels() -> None:
    client = Client()
    client.cookies[settings.LANGUAGE_COOKIE_NAME] = "pl"
    response = client.get(reverse("javascript-catalog"), **HOST)
    body = response.content.decode("utf-8")
    assert response.status_code == 200
    assert "Komunikacja" in body
    assert '"Show in Turn Lanes": "Poka\\u017c w Pasach tur"' in body
    assert "Znormalizowana interakcja" in body
    assert "Inicjalizacja sesji" in body
    assert '"No interaction selected.": "Nie wybrano interakcji."' in body
    assert '"Copy JSON": "Kopiuj JSON"' in body
    # Canonical sections and the missing-value vocabulary of the Content layer.
    assert '"Where": "Gdzie"' in body
    assert '"not in the log": "brak w logu"' in body
    assert '"%s of %s fields": "%s z %s p\\u00f3l"' in body
    assert '"Preview truncated \\u2014 showing %s of %s characters.": "Podgl\\u0105d skr\\u00f3cony \\u2014 pokazano %s z %s znak\\u00f3w."' in body
    # Turn heading: the user message and its expand/collapse control.
    assert '"Collapse": "Zwi\\u0144"' in body
    assert '"Expand (%s characters)": "Rozwi\\u0144 (%s znak\\u00f3w)"' in body
    assert '"No user message in this turn.": "Brak wiadomo\\u015bci u\\u017cytkownika w tej turze."' in body
    assert '"Open the full message": "Otw\\u00f3rz pe\\u0142n\\u0105 wiadomo\\u015b\\u0107"' in body


def test_language_does_not_change_graph_api_payload() -> None:
    path = "/api/graph/?file=demo-session.v4.json"
    english = Client().get(path, HTTP_ACCEPT_LANGUAGE="en", **HOST)
    polish_client = Client()
    polish_client.cookies[settings.LANGUAGE_COOKIE_NAME] = "pl"
    polish = polish_client.get(path, **HOST)
    assert english.status_code == polish.status_code == 200
    assert english.json() == polish.json()

    interaction_id = next(
        node["node_id"]
        for node in english.json()["nodes"]
        if node["node_id"].startswith("interaction:")
    )
    detail_path = f"/api/interaction/?file=demo-session.v4.json&id={interaction_id}"
    english_detail = Client().get(detail_path, HTTP_ACCEPT_LANGUAGE="en", **HOST)
    polish_detail = polish_client.get(detail_path, **HOST)
    assert english_detail.status_code == polish_detail.status_code == 200
    assert english_detail.json() == polish_detail.json()
