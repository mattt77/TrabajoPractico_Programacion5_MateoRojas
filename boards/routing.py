from django.urls import path
from .consumers import NotificationConsumer, BoardConsumer

websocket_urlpatterns = [
    path('ws/notifications/', NotificationConsumer.as_asgi()),
    path('ws/board/<int:board_id>/', BoardConsumer.as_asgi()),
]