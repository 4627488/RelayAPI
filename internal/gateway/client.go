package gateway

import (
	"time"
)

// Client is Relay's local admission controller: in-flight slots, request-body
// memory budget, a bounded queue, and a circuit breaker. After the native
// runtime moved in-process it no longer owns an HTTP transport.
type Client struct {
	admission *admissionController
}

type Options struct {
	MaxInFlight             int
	MaxQueue                int
	MaxRequestBytesInFlight int64
	QueueTimeout            time.Duration
	CircuitFailureThreshold int
	CircuitOpenDuration     time.Duration
}

func New(options Options) *Client {
	if options.MaxInFlight <= 0 {
		options.MaxInFlight = 16
	}
	if options.MaxQueue < 0 {
		options.MaxQueue = 0
	}
	if options.MaxRequestBytesInFlight <= 0 {
		options.MaxRequestBytesInFlight = 8 << 30
	}
	if options.QueueTimeout < 0 {
		options.QueueTimeout = 0
	}
	if options.CircuitFailureThreshold <= 0 {
		options.CircuitFailureThreshold = 3
	}
	if options.CircuitOpenDuration <= 0 {
		options.CircuitOpenDuration = 15 * time.Second
	}
	return &Client{
		admission: newAdmissionController(options.MaxInFlight, options.MaxQueue, options.MaxRequestBytesInFlight, options.QueueTimeout, options.CircuitFailureThreshold, options.CircuitOpenDuration),
	}
}
