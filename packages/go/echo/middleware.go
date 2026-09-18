// Package apphealthecho provides Echo v4 middleware for App Health.
package apphealthecho

import (
	"errors"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	apphealth "github.com/sarthakagrawal927/app-health/packages/go"
)

// Middleware records one privacy-safe endpoint summary after each Echo
// handler. It uses Echo's matched route template and preserves responses,
// returned errors, and panic behavior. Delivery is asynchronous and fail-open.
func Middleware(client *apphealth.Client) echo.MiddlewareFunc {
	if client == nil {
		panic("apphealth/echo: nil client")
	}
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(context echo.Context) (err error) {
			start := time.Now()
			defer func() {
				if recovered := recover(); recovered != nil {
					client.Record(apphealth.RecordInput{
						Method:     context.Request().Method,
						Route:      context.Path(),
						StatusCode: http.StatusInternalServerError,
						Duration:   time.Since(start),
					})
					panic(recovered)
				}

				client.Record(apphealth.RecordInput{
					Method:        context.Request().Method,
					Route:         context.Path(),
					StatusCode:    responseStatus(context, err),
					Duration:      time.Since(start),
					ResponseBytes: responseSize(context),
				})
			}()
			err = next(context)
			return err
		}
	}
}

// responseSize returns the committed response payload size Echo tracked while
// writing, or nil when no response was committed. It is a byte count only.
func responseSize(context echo.Context) *int64 {
	response := context.Response()
	if !response.Committed {
		return nil
	}
	size := response.Size
	return &size
}

func responseStatus(context echo.Context, err error) int {
	response := context.Response()
	if response.Committed && response.Status >= http.StatusContinue {
		return response.Status
	}
	if err != nil {
		var httpError *echo.HTTPError
		if errors.As(err, &httpError) && httpError.Code >= http.StatusContinue && httpError.Code <= 599 {
			return httpError.Code
		}
		return http.StatusInternalServerError
	}
	if response.Status >= http.StatusContinue {
		return response.Status
	}
	return http.StatusOK
}
