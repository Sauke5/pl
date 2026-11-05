from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Service:
    service_id: str
    container_name: str
    display_name: str
    restartable: bool = True


SERVICES: dict[str, Service] = {
    item.service_id: item
    for item in (
        Service("prometheus", "prometheus", "Prometheus"),
        Service("grafana", "grafana", "Grafana"),
        Service("alertmanager", "alertmanager", "Alertmanager"),
        Service("snmp-exporter", "snmp-exporter", "SNMP Exporter"),
        Service("blackbox", "blackbox_exporter", "Blackbox Exporter"),
        Service("veeam-exporter", "veeam-exporter", "Veeam Exporter"),
        Service("loki", "loki", "Loki"),
        Service("docker-socket-proxy", "docker-socket-proxy", "Docker Socket Proxy"),
        Service("dozzle", "dozzle", "Dozzle"),
        Service("cadvisor", "cadvisor", "cAdvisor"),
        Service("alloy", "alloy", "Grafana Alloy"),
        Service("report-runner", "report-runner", "Report Runner"),
        Service("websites-admin", "websites-admin", "Website Admin"),
        Service("nginx", "nginx", "Nginx", restartable=False),
        Service("monitoring-admin", "monitoring-admin", "Monitoring Admin", restartable=False),
        Service(
            "monitoring-admin-worker",
            "monitoring-admin-worker",
            "Monitoring Admin Worker",
            restartable=False,
        ),
    )
}


def get_service(service_id: str) -> Service:
    try:
        return SERVICES[service_id]
    except KeyError as exc:
        raise UnknownServiceError(service_id) from exc


class UnknownServiceError(ValueError):
    pass
