// Command shep-tui is the terminal cockpit for Shepherd agents.
// Product definition: docs/PRODUCT.md
package main

import (
	"fmt"
	"os"

	"github.com/billiondollarsolo/shep-tui/internal/cli"
)

// Version is set at build time via -ldflags "-X main.Version=…".
var Version = "dev"

func main() {
	if err := cli.Run(Version, os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "shep-tui: %v\n", err)
		os.Exit(1)
	}
}
