package identity

import (
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"testing"
)

func TestResolveCurrentNonRootUser(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	if current.Uid == "0" {
		t.Skip("current test user is root")
	}
	runtime, err := Resolve(current.Username)
	if err != nil {
		t.Fatal(err)
	}
	uid, _ := strconv.ParseUint(current.Uid, 10, 32)
	if runtime.UID != uint32(uid) || runtime.Home != current.HomeDir || runtime.Shell == "" {
		t.Fatalf("unexpected runtime identity: %+v", runtime)
	}
}

func TestResolveRejectsRootAndMissingUser(t *testing.T) {
	if _, err := Resolve("root"); err == nil {
		t.Fatal("root runtime identity must be rejected")
	}
	if _, err := Resolve("flock-user-that-does-not-exist"); err == nil {
		t.Fatal("missing runtime identity must be rejected")
	}
}

func TestResolveGroupID(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	group, err := user.LookupGroupId(current.Gid)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ResolveGroupID(group.Name)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := strconv.ParseUint(current.Gid, 10, 32)
	if got != uint32(want) {
		t.Fatalf("got gid %d, want %d", got, want)
	}
}

func TestApplyConfiguresCredential(t *testing.T) {
	runtime := &Runtime{UID: 1234, GID: 2345, Groups: []uint32{2345, 3456}}
	cmd := exec.Command("true")
	runtime.Apply(cmd)
	credential := cmd.SysProcAttr.Credential
	if credential == nil || credential.Uid != 1234 || credential.Gid != 2345 {
		t.Fatalf("credential not applied: %+v", credential)
	}
	if len(credential.Groups) != 2 || credential.Groups[1] != 3456 {
		t.Fatalf("groups not applied: %+v", credential.Groups)
	}
}

func TestValidateControlIdentity(t *testing.T) {
	runtime := &Runtime{UID: 1234}
	err := runtime.ValidateControlIdentity()
	if os.Geteuid() == 0 && err != nil {
		t.Fatalf("root should be able to drop privileges: %v", err)
	}
	if os.Geteuid() != 0 && err == nil {
		t.Fatal("non-root control identity must fail closed")
	}
}
