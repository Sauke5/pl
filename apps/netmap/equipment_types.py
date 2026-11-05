"""Inventory display kinds from explicit NetBox roles, never device identity hints."""
import re


def _key(value):
    return re.sub(r'[\s_-]+', ' ', str(value or '').strip().casefold())


# Exact role names/slugs only. Substring matches would classify unrelated roles
# such as "switch management server" as switches. Unmapped roles retain the
# historical server fallback until inventory has an explicit equipment role.
_ROLE_LABELS = {
    'esxi': ('esxi', 'virtualization host', 'virtualizationhost', 'hypervisor',
             'хост виртуализации', 'гипервизор', 'хост esxi'),
    'router': ('router', 'маршрутизатор'),
    'firewall': ('firewall', 'gateway', 'security gateway', 'межсетевой экран',
                 'шлюз', 'шлюз безопасности'),
    'switch': ('switch', 'network switch', 'access switch', 'core switch',
               'distribution switch', 'коммутатор', 'коммутатор доступа',
               'коммутатор ядра', 'коммутатор агрегации'),
    'storage': ('storage', 'storage system', 'san', 'nas', 'схд',
                'система хранения данных'),
    'server': ('server', 'physical server', 'сервер', 'физический сервер'),
    'computer': ('computer', 'pc', 'desktop', 'workstation', 'laptop',
                 'компьютер', 'пк', 'рабочая станция', 'ноутбук'),
    'phone': ('phone', 'ip phone', 'telephone', 'voip phone', 'телефон',
              'ip телефон', 'ipphone'),
    'printer': ('printer', 'network printer', 'mfp', 'multifunction printer',
                'принтер', 'сетевой принтер', 'мфу'),
    'hub': ('hub', 'network hub', 'ethernet hub', 'хаб', 'сетевой концентратор'),
    'camera': ('camera', 'ip camera', 'network camera', 'камера',
               'ip камера', 'видеокамера'),
    'recorder': ('recorder', 'video recorder', 'nvr', 'dvr', 'видеорегистратор'),
    'passive': ('passive', 'rack equipment', 'rack shelf', 'power distribution',
                'pdu', 'patch panel', 'оборудование стойки', 'полка стойки',
                'распределение питания', 'патч панель'),
}
_ROLE_KINDS = {}
for _kind, _labels in _ROLE_LABELS.items():
    for _label in (_kind, *_labels, 'topology-' + _kind):
        _ROLE_KINDS[_key(_label)] = _kind


def inventory_kind(role_name='', role_slug='', host_uuid=None):
    """Return an export-only kind; established ESXi identity takes precedence.

    A recognized stable slug wins over its editable display label. Neither
    hostname, model, manufacturer nor MAC address participates in this mapping.
    """
    if host_uuid:
        return 'esxi'
    return _ROLE_KINDS.get(_key(role_slug),
                           _ROLE_KINDS.get(_key(role_name), 'server'))
