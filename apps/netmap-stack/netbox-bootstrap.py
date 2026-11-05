"""Runs inside the owned NetBox after migrations. No remote installation inputs."""
import json
from pathlib import Path
from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from users.models import User, Token
from extras.models import CustomField, Tag

config = json.loads(Path('/run/secrets/netbox.json').read_text())
with transaction.atomic():
    # NetBox 4.7 uses its own User model; it has no Django is_staff field.
    admin, created = User.objects.get_or_create(username='pl-admin', defaults={'is_superuser': True, 'is_active': True})
    if created:
        admin.set_password(config['admin_password'])
        admin.save()
    service, created = User.objects.get_or_create(username='pl-netmap', defaults={'is_superuser': True, 'is_active': True})
    if created:
        service.set_unusable_password()
        service.save()
    if service.has_usable_password() or not service.is_superuser or not service.is_active:
        raise RuntimeError('Owned NetBox service account identity conflict')
    token, created = Token.objects.get_or_create(key=config['token_key'], defaults={
        'version': 2, 'user': service, 'description': 'PL owned NetMap adapter', 'token': config['token'], 'write_enabled': True})
    if (token.user_id != service.pk or token.version != 2 or not token.validate(config['token'])
            or not token.is_active or not token.write_enabled):
        raise RuntimeError('Owned NetBox API token identity conflict')
    for slug, name in [('pl-managed', 'PL managed inventory'), ('network-config-backup', 'Network configuration backup')]:
        Tag.objects.get_or_create(slug=slug, defaults={'name': name, 'color': '2196f3'})
    device_type = ContentType.objects.get(app_label='dcim', model='device')
    for name in ('collector_ip', 'oxidized_model', 'collector_profile', 'pl_source', 'pl_observed_name', 'pl_observed_description'):
        field, created = CustomField.objects.get_or_create(name=name, defaults={'type': 'text', 'label': name})
        if field.type != 'text':
            raise RuntimeError('Owned NetBox custom field type conflict')
        field.object_types.add(device_type)

    interface_type = ContentType.objects.get(app_label='dcim', model='interface')
    for name in ('pl_source', 'pl_if_index', 'pl_observed_if_name', 'pl_observed_if_alias', 'pl_observed_if_type', 'pl_observed_admin_status', 'pl_observed_oper_status'):
        field, created = CustomField.objects.get_or_create(name=name, defaults={'type': 'text', 'label': name})
        if field.type != 'text':
            raise RuntimeError('Owned NetBox interface field type conflict')
        field.object_types.add(interface_type)
