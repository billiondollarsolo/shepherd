package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"github.com/billiondollarsolo/flock/agentd/controlauth"
	"github.com/billiondollarsolo/flock/agentd/proto"
)

type probeConfig struct {
	socket, secretFile, nodeIDFile string
	timeout                        time.Duration
}

func parseProbeConfig(command string, args []string) probeConfig {
	flags := flag.NewFlagSet(command, flag.ExitOnError)
	socket := flags.String("socket", defaultSocket(), "unix socket path")
	secretFile := flags.String("secret-file", os.Getenv("FLOCK_AGENTD_SECRET_FILE"), "protected shared-secret file")
	nodeIDFile := flags.String("node-id-file", os.Getenv("FLOCK_AGENTD_NODE_ID_FILE"), "stable node identity file")
	timeout := flags.Duration("timeout", 2*time.Second, "request timeout")
	_ = flags.Parse(args)
	if *socket == "" || *secretFile == "" || *nodeIDFile == "" {
		fatal(command+" configuration", fmt.Errorf("socket, secret-file, and node-id-file are required"))
	}
	return probeConfig{*socket, *secretFile, *nodeIDFile, *timeout}
}

// probe performs the same real mutual authentication as the orchestrator. A
// stale socket file can therefore never make container health pass.
func probe(args []string) {
	connection, _, _ := authenticatedProbe(parseProbeConfig("probe", args), "operation")
	_ = connection.Close()
}

// inspect emits the authenticated daemon/session facts needed by upgrade
// preflight without exposing the shared credential or requiring application login.
func inspect(args []string) {
	// Inspect is a one-shot request, so use an operation connection. A control
	// connection immediately receives replayed status events; those can race the
	// list response and made `inspect` fail whenever a live session had status.
	connection, challenge, nodeID := authenticatedProbe(parseProbeConfig("inspect", args), "operation")
	defer connection.Close()
	if err := proto.WriteControl(connection, proto.Control{Op: "list"}); err != nil {
		fatal("inspect list", err)
	}
	sessions, err := readProbeControl(connection)
	if err != nil || sessions.Op != "sessions" {
		fatal("inspect list", fmt.Errorf("daemon did not return its session inventory"))
	}
	inventory := sessions.Sessions
	if inventory == nil {
		inventory = []proto.SessionInfo{}
	}
	result := struct {
		NodeID          string              `json:"nodeId"`
		DaemonVersion   string              `json:"daemonVersion"`
		ProtocolVersion int                 `json:"protocolVersion"`
		Capabilities    []string            `json:"capabilities"`
		Sessions        []proto.SessionInfo `json:"sessions"`
	}{nodeID, challenge.DaemonVersion, proto.ProtocolVersion, challenge.Capabilities, inventory}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fatal("inspect output", err)
	}
}

func authenticatedProbe(config probeConfig, role string) (net.Conn, proto.Control, string) {
	secretBytes, err := os.ReadFile(config.secretFile)
	if err != nil {
		fatal("probe credential", err)
	}
	nodeBytes, err := os.ReadFile(config.nodeIDFile)
	if err != nil {
		fatal("probe node identity", err)
	}
	secret := strings.TrimSpace(string(secretBytes))
	nodeID := strings.TrimSpace(string(nodeBytes))
	if secret == "" || nodeID == "" {
		fatal("probe identity", fmt.Errorf("credential and node identity must not be empty"))
	}
	connection, err := net.DialTimeout("unix", config.socket, config.timeout)
	if err != nil {
		fatal("probe connect", err)
	}
	_ = connection.SetDeadline(time.Now().Add(config.timeout))
	clientNonce, err := controlauth.Nonce()
	if err != nil {
		fatal("probe nonce", err)
	}
	credentialID := controlauth.CredentialID(secret)
	if err := proto.WriteControl(connection, proto.Control{
		Op: "hello", ProtocolVersion: proto.ProtocolVersion, NodeID: nodeID,
		ClientNonce: clientNonce, CredentialID: credentialID, ConnectionRole: role,
	}); err != nil {
		fatal("probe hello", err)
	}
	challenge, err := readProbeControl(connection)
	if err != nil || challenge.Op != "challenge" || challenge.NodeID != nodeID ||
		challenge.ClientNonce != clientNonce || challenge.CredentialID != credentialID ||
		challenge.ServerNonce == "" || challenge.DaemonVersion == "" || challenge.ConnectionRole != role {
		_ = connection.Close()
		fatal("probe challenge", fmt.Errorf("daemon returned invalid authenticated identity"))
	}
	expected := controlauth.MAC(secret, "server", nodeID, clientNonce,
		challenge.ServerNonce, challenge.DaemonVersion, challenge.Capabilities)
	if !controlauth.Verify(expected, challenge.ServerMAC) {
		_ = connection.Close()
		fatal("probe challenge", fmt.Errorf("daemon authentication failed"))
	}
	if err := proto.WriteControl(connection, proto.Control{
		Op: "authenticate", NodeID: nodeID, ClientNonce: clientNonce, ServerNonce: challenge.ServerNonce,
		ClientMAC: controlauth.MAC(secret, "client", nodeID, clientNonce,
			challenge.ServerNonce, challenge.DaemonVersion, challenge.Capabilities),
	}); err != nil {
		fatal("probe authenticate", err)
	}
	ok, err := readProbeControl(connection)
	if err != nil || ok.Op != "helloOk" || ok.NodeID != nodeID ||
		ok.DaemonVersion != challenge.DaemonVersion || ok.ProtocolVersion != proto.ProtocolVersion ||
		ok.ConnectionRole != role {
		_ = connection.Close()
		fatal("probe result", fmt.Errorf("daemon handshake did not complete"))
	}
	return connection, challenge, nodeID
}

func readProbeControl(connection net.Conn) (proto.Control, error) {
	for {
		frameType, payload, err := proto.ReadFrame(connection)
		if err != nil {
			return proto.Control{}, err
		}
		if frameType == proto.TypeControl {
			return proto.DecodeControl(payload)
		}
	}
}
