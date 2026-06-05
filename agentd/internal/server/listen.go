package server

import "net"

// Serve accepts connections on ln until it errors, handling each concurrently.
func (s *Server) Serve(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go s.HandleConn(c)
	}
}
