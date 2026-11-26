package core

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

// Client talks to the agent over its local API only (spec A5): 127.0.0.1, with the x-nookdeck header.
type Client struct {
	Port int
	HTTP *http.Client
}

func NewClient(port int) *Client {
	return &Client{Port: port, HTTP: &http.Client{Timeout: 6 * time.Second}}
}

func (c *Client) base() string { return "http://127.0.0.1:" + strconv.Itoa(c.Port) }

// ManageURL is the agent's manage page.
func (c *Client) ManageURL() string { return c.base() + "/manage/" }

func (c *Client) do(ctx context.Context, method, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.base()+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-nookdeck", "1")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		return fmt.Errorf("agent answered %d", res.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(body, out)
}

type Device struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

type Address struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Host  string `json:"host"`
	Label string `json:"label"`
	Note  string `json:"note,omitempty"`
	URL   string `json:"url"`
}

type Pairing struct {
	Addresses      []Address `json:"addresses"`
	DefaultAddress string    `json:"defaultAddress"`
	PIN            string    `json:"pin"`
	URL            string    `json:"url"`
	Port           int       `json:"port"`
}

type DoctorItem struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
	Detail string `json:"detail"`
}

type Doctor struct {
	Version string       `json:"version"`
	Items   []DoctorItem `json:"items"`
}

type Update struct {
	Current   string  `json:"current"`
	Latest    *string `json:"latest"`
	Available bool    `json:"available"`
	Enabled   bool    `json:"enabled"`
	Error     string  `json:"error,omitempty"`
}

func (c *Client) Devices(ctx context.Context) ([]Device, error) {
	var d []Device
	return d, c.do(ctx, "GET", "/api/devices", &d)
}

// Pairing returns the PIN and one entry per address a phone can use (all=1: every subnet).
func (c *Client) Pairing(ctx context.Context) (Pairing, error) {
	var p Pairing
	return p, c.do(ctx, "GET", "/api/pairing?all=1", &p)
}

func (c *Client) NewPIN(ctx context.Context) (Pairing, error) {
	var p Pairing
	return p, c.do(ctx, "POST", "/api/pairing/regenerate?all=1", &p)
}

func (c *Client) Doctor(ctx context.Context) (Doctor, error) {
	var d Doctor
	return d, c.do(ctx, "GET", "/api/doctor", &d)
}

func (c *Client) Update(ctx context.Context, refresh bool) (Update, error) {
	var u Update
	path := "/api/update"
	if refresh {
		path += "?refresh=1"
	}
	return u, c.do(ctx, "GET", path, &u)
}

// Online counts the phones connected now.
func Online(ds []Device) int {
	n := 0
	for _, d := range ds {
		if d.Online {
			n++
		}
	}
	return n
}

type State string

const (
	StateRunning   State = "running"
	StateStopped   State = "stopped"
	StateAttention State = "attention"
)

// StateOf turns what the app knows into the tray state. reachable: the agent answered. serviceInstalled/serviceRunning: from the
// Task Scheduler. A reachable agent with a failing doctor item (a missing firewall rule, say) needs attention.
func StateOf(reachable, serviceRunning bool, doctor *Doctor) State {
	if !reachable {
		if serviceRunning {
			return StateAttention // the task runs but nothing answers: starting up or crashed
		}
		return StateStopped
	}
	if doctor != nil {
		for _, it := range doctor.Items {
			if it.Status == "missing" || it.Status == "denied" {
				return StateAttention
			}
		}
	}
	return StateRunning
}
