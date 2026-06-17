import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async

class NotificationConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        self.user = self.scope.get('user')
        if not self.user or not self.user.is_authenticated:
            await self.close()
            return
        self.group_name = f'user_{self.user.id}'
        await self.channel_layer.group_add(
            self.group_name,
            self.channel_name
        )
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(
                self.group_name,
                self.channel_name
            )

    async def notification_message(self, event):
        await self.send(text_data=json.dumps({
            'message': event['message']
        }))
class BoardConsumer(AsyncWebsocketConsumer):
    """Un cliente se conecta acá mientras tiene un tablero abierto.
    Si otro usuario mueve/crea/borra una lista o tarjeta de ESE tablero,
    todos los conectados reciben un aviso para refrescar la vista."""

    async def connect(self):
        self.user = self.scope.get('user')
        self.board_id = self.scope['url_route']['kwargs']['board_id']

        if not self.user or not self.user.is_authenticated:
            await self.close()
            return

        tiene_acceso = await self.usuario_puede_ver_el_tablero(self.user, self.board_id)
        if not tiene_acceso:
            await self.close()
            return

        self.group_name = f'board_{self.board_id}'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, 'group_name'):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def board_update(self, event):
        await self.send(text_data=json.dumps({'type': 'board_update'}))

    @database_sync_to_async
    def usuario_puede_ver_el_tablero(self, user, board_id):
        from .models import Board
        try:
            board = Board.objects.get(pk=board_id)
        except Board.DoesNotExist:
            return False
        es_admin = hasattr(user, 'profile') and user.profile.level == 0
        return es_admin or board.owner_id == user.id or board.members.filter(id=user.id).exists()