from django.urls import include, path
from django.views.i18n import JavaScriptCatalog
from visualization import views

urlpatterns = [
    path("", views.home, name="home"),
    path("visualization/", views.execution_observatory_view, name="visualization"),
    path("logs/", views.log_manager_view, name="log_manager"),
    path("instructions/", views.instructions_view, name="instructions"),
    path("api/graph/", views.graph_api, name="graph_api"),
    path("api/interaction/", views.interaction_api, name="interaction_api"),
    path("i18n/", include("django.conf.urls.i18n")),
    path("jsi18n/", JavaScriptCatalog.as_view(), name="javascript-catalog"),
]
