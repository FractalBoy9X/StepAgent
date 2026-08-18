from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-only-change-me")
DEBUG = os.environ.get("DJANGO_DEBUG", "true").lower() in {"1", "true", "yes"}
ALLOWED_HOSTS = [h.strip() for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()]

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "visualization",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.locale.LocaleMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
]
ROOT_URLCONF = "agentic_app.urls"
TEMPLATES = [{
    "BACKEND": "django.template.backends.django.DjangoTemplates",
    "DIRS": [BASE_DIR / "templates"],
    "APP_DIRS": True,
    "OPTIONS": {"context_processors": [
        "django.template.context_processors.request",
        "django.contrib.messages.context_processors.messages",
    ]},
}]
# Cookie storage keeps the app database-free (no sessions backend required).
MESSAGE_STORAGE = "django.contrib.messages.storage.cookie.CookieStorage"
WSGI_APPLICATION = "agentic_app.wsgi.application"
ASGI_APPLICATION = "agentic_app.asgi.application"
STATIC_URL = "static/"
USE_I18N = True
LANGUAGE_CODE = os.environ.get("DJANGO_LANGUAGE_CODE", "en")
LANGUAGES = [
    ("pl", "Polski"),
    ("en", "English"),
]
LOCALE_PATHS = [BASE_DIR / "locale"]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
