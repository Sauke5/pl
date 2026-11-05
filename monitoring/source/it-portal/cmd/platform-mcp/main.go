package main

import (
	"context"
	"errors"
	"flag"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"log"
	"os"
	"os/signal"
	"pl/portal/internal/platformmcp"
)

type options struct {
	base, token string
	write       bool
}

func parseOptions(args []string) (options, error) {
	var o options
	f := flag.NewFlagSet("platform-mcp", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	f.StringVar(&o.base, "url", "", "Required Platform HTTPS origin")
	f.StringVar(&o.token, "token-file", "", "Protected file containing a scoped machine token")
	f.BoolVar(&o.write, "write", false, "Expose catalog/discovery write tools (server scopes still apply)")
	if err := f.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return o, flag.ErrHelp
		}
		return o, errors.New("usage: platform-mcp -url https://platform.example -token-file /path/to/token [-write]")
	}
	if f.NArg() != 0 || o.base == "" {
		return o, errors.New("provide the Platform endpoint explicitly: -url https://platform.example -token-file /path/to/token")
	}
	return o, nil
}

func main() {
	o, e := parseOptions(os.Args[1:])
	if errors.Is(e, flag.ErrHelp) {
		_, _ = os.Stderr.WriteString("usage: platform-mcp -url https://platform.example -token-file /path/to/token [-write]\n")
		return
	}
	if e != nil {
		log.Fatal(e)
	}
	c, e := platformmcp.NewClient(o.base, o.token)
	if e != nil {
		log.Fatal(e)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if e = platformmcp.NewServer(c, o.write).Run(ctx, &mcp.StdioTransport{}); e != nil {
		log.Fatal(e)
	}
}
