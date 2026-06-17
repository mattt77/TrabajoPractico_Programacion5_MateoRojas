from django.db.models.signals import post_save, post_delete, pre_delete
from django.dispatch import receiver
from .models import List, Card

# Cache temporal para no perder el board_id de una tarjeta justo antes de
# borrarla (mismo patrón que usamos en notifications/signals.py con assigned_to).
_card_board_cache = {}


def _broadcast_board_update(board_id):
    """Avisa por WebSocket a todos los clientes conectados a ese tablero
    que algo cambió, para que refresquen la vista."""
    if not board_id:
        return
    try:
        from channels.layers import get_channel_layer
        from asgiref.sync import async_to_sync
        channel_layer = get_channel_layer()
        if channel_layer is None:
            return
        async_to_sync(channel_layer.group_send)(
            f'board_{board_id}',
            {'type': 'board_update'}
        )
    except Exception:
        pass


@receiver(post_save, sender=List)
def list_changed(sender, instance, **kwargs):
    _broadcast_board_update(instance.board_id)


@receiver(post_delete, sender=List)
def list_removed(sender, instance, **kwargs):
    _broadcast_board_update(instance.board_id)


@receiver(post_save, sender=Card)
def card_changed(sender, instance, **kwargs):
    _broadcast_board_update(instance.list.board_id)


@receiver(pre_delete, sender=Card)
def card_about_to_be_removed(sender, instance, **kwargs):
    # Guardamos el board_id ANTES de que se borre la tarjeta: si se está
    # borrando porque se borró toda la lista (cascada), en este momento
    # la lista todavía existe en la base.
    try:
        _card_board_cache[instance.pk] = instance.list.board_id
    except List.DoesNotExist:
        _card_board_cache[instance.pk] = None


@receiver(post_delete, sender=Card)
def card_removed(sender, instance, **kwargs):
    board_id = _card_board_cache.pop(instance.pk, None)
    _broadcast_board_update(board_id)