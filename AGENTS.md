# StepAgent - kontekst dla agentow

> Wersja formatu danych: `schema_version = 4`

## Cel dokumentu

Ten plik jest punktem startowym dla agenta pracujacego nad tym repozytorium.
Opisuje aktualna architekture, kontrakty, sposob uruchamiania, testy i znane
ograniczenia. Przed zmiana kodu agent powinien przeczytac ten plik oraz
dokumenty wskazane w sekcji "Zrodla prawdy".

## Stan projektu w skrocie

- Projekt jest lokalna, bezbazowa aplikacja Django do analizy sesji Codex.
- Surowe sesje JSONL sa zachowywane bezstratnie jako `raw_records`.
- Powiazane zdarzenia begin/delta/end/result sa agregowane do semantycznych
  `interactions`.
- Po normalizacji wyznaczane sa tury konwersacyjne: samodzielna wiadomosc
  uzytkownika rozpoczyna ture, odpowiedz sterujaca jej nie rozpoczyna, a
  zdarzenia wczesniejsze tworza segment `initialization`.
- Z interakcji budowany jest graf wykonania z relacjami jawnymi i wnioskowanymi.
- Glowna wizualizacja zawiera wylacznie dwa widoki 2D: Turn Lanes oraz Activity
  Matrix. Projekt nie ma aktywnego renderera 3D ani zaleznosci Plotly.
- Turn Lanes zachowuje kazda interakcje parsera jako numerowany krok i przewija
  dlugie tury zamiast sciskac lub agregowac markery.
- Activity Matrix porownuje rodziny interakcji miedzy turami, a dla jednej tury
  dzieli chronologie na kolejne zakresy krokow.
- UI pozwala wybrac sesje, filtrowac tabele, klikac kroki i komorki macierzy oraz
  pobierac surowe rekordy jednej wybranej interakcji.
- Interfejs obsluguje polski i angielski przez Django i18n. Pierwszy jezyk wynika
  z `Accept-Language`, jawny wybor PL/ENG jest zapisywany w cookie, a angielski
  pozostaje fallbackiem. Dane sesji i payloady API nie sa tlumaczone.
- Projekt nie korzysta z modeli Django, migracji bazy, panelu admina, logowania
  ani sesji HTTP.

## Struktura katalogow

```text
stepagent/
|-- agentic_app/                   # konfiguracja Django, URL, ASGI i WSGI
|-- AGENTS.md                      # ten dokument: mapa projektu dla agentow
|-- docs/
|   |-- ARCHITECTURE.md            # pipeline, widoki 2D i granice inferencji
|   `-- MIGRATION.md               # zasady przejscia na schema v4
|-- json_downloader/               # pomocniczy skrypt pobierania JSON
|-- locale/pl/LC_MESSAGES/         # katalogi gettext django i djangojs
|-- scripts/
|   `-- export_graph.py            # eksport znormalizowanego grafu JSON
|-- templates/
|   |-- base.html                  # wspolny shell i style aplikacji
|   |-- execution_observatory.html # shell Turn Lanes/Matrix i panel szczegolow
|   |-- home.html                  # lista przetworzonych sesji
|   |-- instructions.html          # instrukcje dostepne w UI
|   `-- log_manager.html           # import surowych sesji
|-- tests/                         # testy parsera, grafu, widokow 2D i serializacji
|-- visualization/
|   |-- adapters.py                # dekoder JSONL i normalizacja protokolu Codex
|   |-- conversation_turns.py      # deterministyczne granice tur konwersacyjnych
|   |-- domain.py                  # dataclasses, enumy i schema v4
|   |-- graph_builder.py           # SessionDocument -> ExecutionGraph
|   |-- listing.py                  # model wiersza inwentarza sesji
|   |-- provenance.py               # metryka zrodla importu i cache naglowkow
|   |-- repositories.py            # bezpieczny dostep do raw i processed files
|   |-- services.py                # orkiestracja importu i budowy grafu
|   |-- two_d_views.py             # kompaktowy model Turn Lanes i Activity Matrix
|   |-- views.py                   # strony Django i API
|   |-- static/visualization/      # natywny renderer HTML/CSS/JS widokow 2D
|   `-- data/sessions_json/        # lokalne, przetworzone pliki *.v4.json
|-- codex_prettify.py              # CLI importera schema-v4
|-- jsonl_deminify.py              # pomocnicze formatowanie JSONL
|-- manage.py                      # Django CLI
|-- run.sh                         # import i/lub uruchomienie serwera (macOS/Linux)
|-- run.ps1                        # to samo na Windows
|-- pyproject.toml                 # zaleznosci i wymagana wersja Pythona (uv)
|-- .python-version                # wersja interpretera pobierana przez uv
|-- requirements.txt               # Django (sciezka zapasowa dla pip)
`-- requirements-dev.txt           # pytest (sciezka zapasowa dla pip)
```

Produkcyjna wersja Turn Lanes i Activity Matrix znajduje sie w tym projekcie;
poza repozytorium nie ma zadnych wymaganych katalogow towarzyszacych.

## Przeplyw danych

```text
~/.codex/sessions/**/*.jsonl
  -> iter_json_objects() / RawRecord
  -> parse_codex_records() / Interaction
  -> assign_conversation_turns()
  -> SessionDocument (schema v4)
  -> visualization/data/sessions_json/*.v4.json
  -> build_execution_graph()
  -> ExecutionGraph
  -> build_2d_payload()
  -> kompaktowe families / turns / steps
  -> natywne HTML buttons i CSS grid
  -> Django UI oraz API JSON
```

Dekoder JSONL obsluguje rekordy rozdzielone liniami i sklejone obiekty JSON.
Wejscie jest dekodowane przyrostowo, ale `parse_codex_records()` materializuje
liste rekordow podczas normalizacji. To istotne ograniczenie dla bardzo duzych
sesji. Niedokonczony bufor wejsciowy ma limit 50 MB.

## Model domenowy i kontrakty

Aktualny model w `visualization/domain.py` zawiera:

- 14 rodzin `InteractionFamily`;
- 2 rodzaje `ConversationTurnKind`: `initialization` i `user_message`;
- 10 stanow `LifecycleState`;
- 35 typow `NodeKind`;
- 45 typow `EdgeKind`;
- `RawRecord`, `Interaction`, `GraphNode`, `GraphEdge`, `SessionDocument` i
  `ExecutionGraph` jako dataclasses.

Najwazniejsze niezmienniki:

1. `SCHEMA_VERSION` pozostaje rowne `4`, dopoki jawnie nie powstanie migracja.
2. Kazdy obiekt z wejsciowego JSONL ma odpowiadajacy `RawRecord`; nie wolno
   odrzucac nieznanych wariantow protokolu.
3. Nieznane typy staja sie `event_unknown`, a oryginalny payload pozostaje w raw.
4. Jedna interakcja moze laczyc wiele rekordow cyklu zycia przez `raw_record_ids`.
5. Korelacja preferuje stabilne ID: item/call/thread/turn/agent. Fingerprint tresci
   jest waskim fallbackiem dla znanych lustrzanych message/reasoning.
6. `NEXT` opisuje tylko chronologie. Zaleznosci przyczynowe maja dedykowane typy
   krawedzi.
7. Relacje wnioskowane musza zachowac `inferred`, `confidence` i `detected_by`.
8. Pliki v3 i splaszczone legacy JSON sa celowo odrzucane. Nalezy ponownie
   przetworzyc oryginalny JSONL.
9. `turn_id` i `turn_number` sa wartosciami technicznymi ze zrodla. Nie wolno
   uzywac ich jako granic tur prezentowanych uzytkownikowi.
10. Ture konwersacyjna rozpoczyna tylko samodzielna wiadomosc uzytkownika.
    Odpowiedzi na aktywne approval/permission/request-user-input pozostaja w
    biezacej turze, a zdarzenia przed pierwsza wiadomoscia maja numer 0 i rodzaj
    `initialization`.

Rejestr parsera rozpoznaje obecnie 8 typow rollout, 18 response-item i 84 typy
event-message. Dodajac nowy typ protokolu, nalezy zaktualizowac mape adaptera,
zachowac fallback unknown oraz dodac test kontraktu.

## Budowa grafu

`visualization/graph_builder.py` tworzy:

- wezly strukturalne sesji, tur konwersacyjnych i agentow;
- wezly semantyczne interakcji;
- artefakty, pliki, adresy URL, kroki planu i bledy;
- relacje sterowania czlowieka, wywolan i wynikow, retry oraz chronologii;
- metryki sesji wykorzystywane przez UI.

Granice inferencji:

- deduplikacja lustrzanych message/reasoning bez wspolnego ID dotyczy tylko
  sasiadujacych rekordow o identycznej, znormalizowanej tresci w tej samej turze
  zrodlowej; pozniejsze identyczne wiadomosci pozostaja osobnymi interakcjami;
- oczekujace zadanie human-control klasyfikuje najblizsza wiadomosc uzytkownika
  jako odpowiedz sterujaca; jawna odpowiedz protokolu lub wznowione wykonanie
  zamyka ten stan;
- sciezki artefaktow sa strukturalne, gdy wynikaja z argumentow lub patcha, a w
  pozostalych przypadkach heurystyczne;
- retry jest wnioskowane z tego samego podpisu wykonania po nieudanej probie;
- brakujacy wynik narzedzia pozostaje osobnym wezelm, nie jest po cichu usuwany.

## Widoki 2D

`visualization/two_d_views.py` tworzy deterministyczny model prezentacji:

- wybiera tylko wezly `interaction:*` posiadajace `interaction_index`;
- sortuje je zgodnie z kolejnoscia parsera;
- przydziela `step_number` wewnatrz kazdej tury konwersacyjnej;
- tworzy komorki family-by-conversation-turn dla Activity Matrix;
- pozostawia artefakty i bledy pochodne poza sekwencja, ale dostepne w relacjach;
- wysyla do HTML skrocone dane, bez pelnych result i raw payloadow.

`observatory-2d.js` renderuje oba wykresy natywnymi elementami DOM. Turn Lanes ma
jedna przewijana os na ture konwersacyjna i nie agreguje krokow. Inicjalizacja
sesji jest osobnym, przerywanym pasem. Activity Matrix uzywa tych samych segmentow
jako kolumn, a po wybraniu jednego dzieli jego kroki na maksymalnie 24 kolejne
zakresy. Komorka rozwija liste dokladnych interakcji.

Przy zmianach wizualizacji trzeba zachowac:

- chronologie zgodna z `interaction_index` i numeracje krokow per tura;
- osobny segment inicjalizacji oraz rozdzielenie tury konwersacyjnej od zrodlowej
  w panelu szczegolow;
- dzialanie klikniecia kroku, komorki, wiersza tabeli i przycisku relacji;
- wspolny stan wyboru i mozliwosc przejscia do kroku w Turn Lanes;
- brak raw payloadow w poczatkowym HTML;
- pelne dane pobierane tylko przez `/api/interaction/` po wyborze interakcji;
- brak Plotly, WebGL, canvas, SVG hit-testingu, animacji i timerow renderera.

## Warstwa HTTP

| Sciezka | Rola |
|---|---|
| `/` | lista zapisanych sesji |
| `/visualization/` | Turn Lanes, Activity Matrix, explorer i szczegoly |
| `/logs/` | lista raw JSONL oraz import jednej lub wszystkich nowych sesji |
| `/instructions/` | instrukcje uzytkownika |
| `/api/graph/?file=<name>` | graf bez surowych payloadow |
| `/api/interaction/?file=<name>&id=<id>` | jedna interakcja i przypisane raw records |
| `/i18n/setlang/` | standardowy POST Django zapisujacy wybor jezyka |
| `/jsi18n/` | katalog tlumaczen dla observatory-2d.js |

Nazwy plikow w API/repozytorium sa walidowane jako basename. Sciezki raw musza
pozostac wewnatrz `CODEX_SESSIONS_DIR`. Nie oslabiaj tych kontroli.

Pola `conversation_turn_id`, `conversation_turn_number` i
`conversation_turn_kind` sa addytywnym rozszerzeniem schema v4. Starszy plik v4
bez tych pol jest wzbogacany deterministycznie w pamieci; masowa migracja nie jest
wymagana. Nowe eksporty zapisuja pola jawnie.

## Lokalizacja interfejsu

- Obslugiwane kody to `pl` i `en`; przelacznik pokazuje etykiety PL/ENG.
- `LocaleMiddleware` wybiera cookie, potem jezyk przegladarki, a na koncu
  `DJANGO_LANGUAGE_CODE` z domyslna wartoscia `en`.
- Szablony korzystaja z domeny `django`, a dynamiczny renderer 2D z `djangojs`.
- Angielski jest jezykiem zrodlowym. Polskie katalogi `.po` i skompilowane `.mo`
  sa przechowywane w `locale/pl/LC_MESSAGES`.
- Tlumaczone sa wylacznie etykiety prezentacyjne. Nie wolno tlumaczyc promptow,
  logow, nazw plikow, stabilnych enumow ani odpowiedzi API.
- Po zmianie tekstu trzeba uruchomic `makemessages` dla obu domen, uzupelnic
  wszystkie polskie `msgstr`, a nastepnie wykonac `compilemessages -l pl`.

## Storage i import

- Domyslne zrodlo: `~/.codex/sessions`, konfigurowane przez
  `CODEX_SESSIONS_DIR`.
- Domyslny cel: `visualization/data/sessions_json`.
- Repozytorium widzi tylko `*.v4.json` i pomija pliki AppleDouble `._*`.
- Nazwa eksportu jest stabilnie wyliczana z relatywnej sciezki raw, z segmentami
  laczonymi przez `__`.
- Zapis nastepuje do pliku tymczasowego, potem jest pelna walidacja parserem v4 i
  atomowa podmiana.
- `AGENTIC_MAX_INTERACTIONS` ogranicza graf renderowany w przegladarce (domyslnie
  5000, minimum 100), ale nie obcina zapisanego raw ani dokumentu v4.
- `--replace-v3` usuwa odpowiadajacy plik v3 dopiero po poprawnym zapisie v4.

Pliki sesji moga zawierac wrazliwe dane, prompt, argumenty polecen, sciezki i
wyniki narzedzi. Nie publikowac ich ani nie kopiowac do fixture bez anonimizacji.

## Uruchamianie

Pierwsza konfiguracja:

Projekt uzywa `uv`. Nie trzeba recznie tworzyc virtualenva ani instalowac
Pythona - `uv` pobiera interpreter z `.python-version` i synchronizuje
zaleznosci z `pyproject.toml` przy pierwszym uruchomieniu.

Import nowych sesji i uruchomienie serwera:

```bash
./run.sh --all --serve          # macOS / Linux
.\run.ps1 --all --serve         # Windows
```

Sam serwer bez importu:

```bash
./run.sh --serve
```

Dowolne polecenie w srodowisku projektu:

```bash
uv run python manage.py runserver 127.0.0.1:8000
```

Gdy port jest zajety, uzyc innego, np. `127.0.0.1:8003`. Nie uruchamiac drugiej
instancji na tym samym porcie.

Import bez serwera:

```bash
python codex_prettify.py --all
python codex_prettify.py --file 2026/08/09/rollout.jsonl
python codex_prettify.py /pelna/sciezka/session.jsonl --output output.v4.json
```

Eksport samodzielnego grafu:

```bash
python scripts/export_graph.py \
  visualization/data/sessions_json/session.v4.json \
  --graph-output session.graph.json
```

## Konfiguracja srodowiska

| Zmienna | Domyslna wartosc | Znaczenie |
|---|---|---|
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | katalog raw JSONL |
| `DJANGO_HOST` | `127.0.0.1` | host dla `run.sh` / `run.ps1` |
| `DJANGO_PORT` | `8000` | port serwera |
| `DJANGO_DEBUG` | `true` | tryb debug |
| `DJANGO_ALLOWED_HOSTS` | `127.0.0.1,localhost` | dozwolone hosty |
| `DJANGO_SECRET_KEY` | wartosc developerska | klucz Django; zmienic poza lokalnym dev |
| `DJANGO_LANGUAGE_CODE` | `en` | fallback, gdy cookie i przegladarka nie wybiora PL/EN |
| `AGENTIC_MAX_INTERACTIONS` | `5000` | limit interakcji w renderowanym grafie |

## Walidacja zmian

Minimalny zestaw po kazdej zmianie kodu:

```bash
source .venv/bin/activate
pytest -q
python manage.py check
```

Aktualny pakiet ma 16 testow obejmujacych:

- sklejone obiekty w strumieniu JSON;
- pokrycie rejestrow typow protokolu;
- bezstratne raw, agregacje lifecycle, deduplikacje i unknown;
- osierocone wyniki narzedzi;
- artefakty, bledy, retry i relacje sterowania;
- chronologie krokow oraz agregacje Activity Matrix;
- inicjalizacje sesji, granice tur konwersacyjnych, odpowiedzi sterujace, zmiany
  tur zrodlowych i powtorzone identyczne wiadomosci;
- wyliczenie nowych pol w pamieci dla starszych plikow schema v4;
- obecnosc tylko natywnych widokow 2D w aktywnym UI;
- wybor PL/EN z przegladarki, cookie i zachowanie pelnej sciezki;
- polski katalog JavaScript oraz niezmiennosc obu API miedzy jezykami;
- akceptacje tylko v4 i ochrone przed traversal;
- round-trip serializacji oraz jawne odrzucenie v3.

Walidacja snapshotu `2026-08-10T01:03:40+02:00`:

- `pytest -q`: 16 passed;
- `python manage.py check`: brak problemow;
- `node --check observatory-2d.js`: poprawna skladnia;
- `compilemessages -l pl` i `msgfmt --check-format`: poprawne katalogi;
- testy potwierdzaja polskie i angielskie HTML, katalog JS, stabilne API oraz
  semantyke tur konwersacyjnych;
- test klienta Django na rzeczywistym pliku potwierdza status 200 strony i API,
  obecnosc nowych pol, 1 ture konwersacyjna, 2 tury zrodlowe i 6 interakcji
  inicjalizacji;
- automatyczna inspekcja wizualna i klikanie nie zostaly wykonane, poniewaz
  runtime przegladarki zwrocil pusta liste dostepnych przegladarek.

Zmiany UI wymagaja dodatkowo testu w przegladarce na desktopie i waskim
viewport. Nalezy sprawdzic co najmniej: obydwie zakladki, przewijanie dlugiej
tury, klik kroku, klik komorki macierzy, wybor dokladnej interakcji z grupy, klik
wiersza, pobranie raw, filtry i brak nakladania kontrolek. Same testy pytest nie
gwarantuja poprawnej interakcji przegladarki.

## Znane ograniczenia i ryzyka

1. Tura z tysiacami interakcji tworzy bardzo szeroki Turn Lane. Jest to celowe,
   poniewaz kroki nie sa ukrywane, ale wymaga przewijania poziomego.
2. Normalizacja nadal materializuje wszystkie rekordy w pamieci.
3. Aplikacja nie ma indeksu miedzy sesjami ani przyrostowego przetwarzania.
4. Import `--all` pomija juz istniejace nazwy bez porownania zawartosci; do
   przebudowy sluzy CLI z `--force`.
5. Semantyczna deduplikacja, wykrywanie artefaktow i retry zawieraja opisane wyzej
   heurystyki; nie nalezy przedstawic relacji inferred jako pewnych.
6. Prototypy `../visualization_propose` nie dziela kodu obslugi klikniec z glownym
   UI. Produkcyjne wykresy uzywaja natywnych przyciskow DOM.
7. Pliki `._*` tworzone na woluminie macOS nie sa kodem. Narzedzia skanujace caly
   katalog powinny je ignorowac.
8. Klasyfikacja odpowiedzi sterujacej jest konserwatywna i zalezy od widocznego
   zadania human-control lub jawnego markera odpowiedzi. Niejednoznaczna wiadomosc
   bez takiego kontekstu rozpoczyna nowa ture konwersacyjna.

## Zasady pracy agenta

Przed implementacja:

1. Przeczytaj ten dokument, `docs/ARCHITECTURE.md`, odpowiedni kod i testy.
2. Sprawdz stan drzewa roboczego; nie cofaj cudzych zmian.
3. Ustal, czy zmiana dotyczy raw, interaction, graph, modelu 2D, renderera czy UI.
4. Zachowaj granice modulow i kontrakty schema-v4.

Podczas implementacji:

1. Rozszerz istniejace mapy i dataclasses zamiast tworzyc rownolegly model.
2. Dla nowych typow protokolu zachowaj raw i bezpieczny fallback unknown.
3. Nie tworz alternatywnej kolejnosci krokow poza `interaction_index`.
4. Nie dodawaj 3D, Plotly, animacji ani ciaglych aktualizacji wykresu.
5. Nie umieszczaj pelnych raw records w `/api/graph/` ani w poczatkowym HTML.
6. Nie tlumacz stabilnych danych protokolu; dodawaj osobne etykiety prezentacyjne.
7. Dodaj test proporcjonalny do ryzyka i uruchom walidacje.

Po implementacji:

1. Zaktualizuj sekcje, na ktore wplynela zmiana.
2. Ustaw nowy timestamp ISO 8601 w naglowku.
3. Utworz nowy, pelny snapshot w tym katalogu zgodnie z konwencja ponizej.
4. Dopisz wynik testow i kazde niewykonane sprawdzenie manualne.
5. Nie nadpisuj ani nie usuwaj starszych snapshotow.

## Zrodla prawdy

W razie rozbieznosci obowiazuje nastepujaca kolejnosc:

1. dzialajacy kod i testy;
2. `visualization/domain.py` dla modelu i wersji schematu;
3. `visualization/adapters.py` dla protokolu wejscia;
4. `docs/ARCHITECTURE.md` i `docs/MIGRATION.md` dla decyzji architektonicznych;
5. ten dokument jako aktualna mapa projektu;
6. `README.md`, `SETUP.md` i `VALIDATION.md`.

Gdy dokumentacja przeczy kodowi, nie zgaduj. Zweryfikuj zachowanie testem,
a nastepnie popraw implementacje albo dokumentacje.
