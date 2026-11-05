package providers

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"syscall"

	"pl/portal/internal/netguard"
)

// Endpoint errors retain only an allowlisted cause. Raw transport errors often
// contain URLs, query parameters, certificate names or directory internals.
var (
	ErrThroughputBusy        = errors.New("throughput_busy")
	ErrThroughputUnavailable = errors.New("throughput_unavailable")
	ErrThroughputIncomplete  = errors.New("throughput_incomplete")
	ErrTLSUntrusted          = errors.New("endpoint_tls_untrusted")
	ErrTLSHostname           = errors.New("endpoint_tls_hostname")
	ErrTLSExpired            = errors.New("endpoint_tls_validity")
	ErrTLSVerification       = errors.New("endpoint_tls_verification")
	ErrDNS                   = errors.New("endpoint_dns")
	ErrTimeout               = errors.New("endpoint_timeout")
	ErrConnectionRefused     = errors.New("endpoint_connection_refused")
	ErrPolicyDenied          = errors.New("endpoint_policy_denied")
	ErrEndpointUnavailable   = errors.New("endpoint_unavailable")
)

func classifyEndpointError(err error) error {
	if err == nil {
		return nil
	}
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var verification *tls.CertificateVerificationError
	var dns *net.DNSError
	var network net.Error
	switch {
	case errors.Is(err, ErrThroughputBusy), errors.Is(err, ErrThroughputUnavailable), errors.Is(err, ErrThroughputIncomplete):
		return err
	case errors.As(err, &unknown):
		return ErrTLSUntrusted
	case errors.As(err, &hostname):
		return ErrTLSHostname
	case errors.As(err, &invalid) && invalid.Reason == x509.Expired:
		return ErrTLSExpired
	case errors.As(err, &verification):
		return ErrTLSVerification
	case errors.Is(err, netguard.ErrPolicyDenied):
		return ErrPolicyDenied
	case errors.Is(err, context.DeadlineExceeded):
		return ErrTimeout
	case errors.As(err, &network) && network.Timeout():
		return ErrTimeout
	case errors.Is(err, netguard.ErrDNS), errors.As(err, &dns):
		return ErrDNS
	case errors.Is(err, syscall.ECONNREFUSED):
		return ErrConnectionRefused
	default:
		return ErrEndpointUnavailable
	}
}

// CheckErrorMessage never returns err.Error(). Use only for check/enrich jobs;
// report/restart retain their existing uncertain-outcome semantics.
func CheckErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrICMPBusy):
		return "ICMP-проверка уже выполняется. Дождитесь завершения."
	case errors.Is(err, ErrICMPUnavailable):
		return "Обработчик ICMP-проверок на хосте Платформы недоступен."
	case errors.Is(err, ErrICMPIncomplete):
		return "ICMP-проверка не завершена. Полный результат не получен; доступный вывод сохранён в технических подробностях."
	case errors.Is(err, ErrThroughputBusy):
		return "Проверка скорости уже выполняется. Дождитесь её завершения."
	case errors.Is(err, ErrThroughputUnavailable):
		return "Замер скорости не завершён. Проверьте, что на выбранном хосте запущен iperf3-сервер, порт доступен и сервер не занят другим замером."
	case errors.Is(err, ErrThroughputIncomplete):
		return "iperf3 не вернул полный результат замера. Скорость не определена."
	case errors.Is(err, ErrTLSUntrusted):
		return "Портал не доверяет сертификату этого сайта."
	case errors.Is(err, ErrTLSHostname):
		return "Сертификат сайта выдан для другого имени."
	case errors.Is(err, ErrTLSExpired):
		return "Сертификат сайта просрочен или ещё не действителен."
	case errors.Is(err, ErrTLSVerification):
		return "Сертификат сайта не прошёл проверку TLS."
	case errors.Is(err, ErrDNS):
		return "Не удалось определить IP-адрес по имени сайта."
	case errors.Is(err, ErrTimeout):
		return "Сайт не ответил за отведённое время."
	case errors.Is(err, ErrConnectionRefused):
		return "Сервис отклонил соединение. Проверьте, что он запущен и порт доступен."
	case errors.Is(err, ErrPolicyDenied):
		return "Проверка этого адреса или порта запрещена настройками доступа портала."
	default:
		return "Не удалось проверить адрес. Проверьте его доступность и настройки подключения."
	}
}
