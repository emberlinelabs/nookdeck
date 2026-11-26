package core

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

const (
	Repo          = "howznguyen/nookdeck"
	InstallerName = "Nookdeck-Setup.exe"
)

// ReleaseURL is a file of a tagged release (the tag is "v" + version).
func ReleaseURL(version, file string) string {
	return "https://github.com/" + Repo + "/releases/download/v" + strings.TrimPrefix(version, "v") + "/" + file
}

// SumFor finds a file's sha256 in a SHA256SUMS text ("<hash>  <name>" per line).
func SumFor(sums, name string) string {
	for _, line := range strings.Split(sums, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name && len(f[0]) == 64 {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

func get(ctx context.Context, c *http.Client, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	res, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		return nil, fmt.Errorf("%s answered %d", url, res.StatusCode)
	}
	return res, nil
}

// DownloadInstaller fetches the Windows installer of `version` to dest, checked against the release's SHA256SUMS.
func DownloadInstaller(ctx context.Context, c *http.Client, version, dest string) error {
	return DownloadAsset(ctx, c, version, InstallerName, dest)
}

// DownloadAsset fetches the file `name` of release `version` to dest and checks it against the release's SHA256SUMS. A file
// whose hash is missing or wrong is deleted and never run.
func DownloadAsset(ctx context.Context, c *http.Client, version, name, dest string) error {
	sr, err := get(ctx, c, ReleaseURL(version, "SHA256SUMS"))
	if err != nil {
		return err
	}
	sums, _ := io.ReadAll(io.LimitReader(sr.Body, 1<<20))
	sr.Body.Close()
	want := SumFor(string(sums), name)
	if want == "" {
		return fmt.Errorf("the release lists no %s", name)
	}
	res, err := get(ctx, c, ReleaseURL(version, name))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, cerr := io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, 200<<20))
	f.Close()
	if cerr != nil {
		os.Remove(dest)
		return cerr
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		os.Remove(dest)
		return fmt.Errorf("checksum mismatch for %s", name)
	}
	return nil
}
