from django.urls import path
from .views import RegisterView, UserListView, CurrentUserView

urlpatterns = [
    path('register/', RegisterView.as_view()),
    path('users/', UserListView.as_view()),
    path('users/me/', CurrentUserView.as_view()),
]