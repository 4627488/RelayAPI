package rai

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

func (a *App) update(ctx context.Context) error {
	server, err := a.updateServer()
	if err != nil {
		return err
	}
	discovery, err := a.Gateway.Discover(ctx, server)
	if err != nil {
		return err
	}
	latest := strings.TrimSpace(discovery.RAIVersion)
	fmt.Fprintf(a.Stdout, "installed: %s\n", Version)
	if latest != "" {
		fmt.Fprintf(a.Stdout, "site:      %s\n", latest)
		if latest == Version || latest == "v"+Version {
			a.terminal(a.Stdout).message("success", "rai matches this site")
			return nil
		}
	}
	rawURL := raiDownloadURL(server, discovery.Download, runtime.GOOS, runtime.GOARCH)
	target := a.Self
	if target == "" || target == "rai" {
		target, err = lookPath("rai")
		if err != nil {
			return err
		}
	}
	fmt.Fprintf(a.Stdout, "downloading %s\n", rawURL)
	progress := a.terminal(a.Stderr).progress("Downloading rai")
	defer progress.clear()
	if err := replaceExecutable(ctx, a.Gateway.HTTP, rawURL, target, progress.update); err != nil {
		return err
	}
	progress.clear()
	if latest == "" {
		latest = "site build"
	}
	a.terminal(a.Stdout).message("success", "updated %s to %s", target, latest)
	return nil
}

func (a *App) updateServer() (string, error) {
	server, _, err := a.loginTarget("", "", false)
	return server, err
}

func raiDownloadURL(server, download, goos, goarch string) string {
	download = strings.TrimSpace(download)
	if download == "" {
		download = "/rai/download"
	}
	target := goos + "-" + goarch
	if strings.HasPrefix(download, "http://") || strings.HasPrefix(download, "https://") {
		return strings.TrimRight(download, "/") + "/" + target
	}
	return strings.TrimRight(server, "/") + "/" + strings.Trim(download, "/") + "/" + target
}

func replaceExecutable(ctx context.Context, client *http.Client, rawURL, target string, report func(int64, int64)) error {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	} else {
		clone := *client
		if clone.Timeout < 2*time.Minute {
			clone.Timeout = 2 * time.Minute
		}
		client = &clone
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "rai/"+Version)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s", resp.Status)
	}
	reader := &downloadProgressReader{Reader: resp.Body, total: resp.ContentLength, report: report}
	data, err := io.ReadAll(io.LimitReader(reader, (64<<20)+1))
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return fmt.Errorf("downloaded empty binary")
	}
	if len(data) > 64<<20 {
		return fmt.Errorf("download exceeds 64 MiB")
	}
	return writeFileAtomicWithReplace(target, data, 0o755, replaceExecutableFile)
}

type downloadProgressReader struct {
	io.Reader
	done, total int64
	report      func(int64, int64)
}

func (r *downloadProgressReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.done += int64(n)
	if r.report != nil && n > 0 {
		r.report(r.done, r.total)
	}
	return n, err
}
