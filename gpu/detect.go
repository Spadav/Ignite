package gpu

import (
	"bytes"
	"os/exec"
	"strconv"
	"strings"
)

type Info struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	VRAM              int    `json:"vram"`
	VRAMUsed          int    `json:"vramUsed"`
	Utilization       int    `json:"utilization"`
	Temperature       int    `json:"temperature"`
	ComputeCapability string `json:"computeCapability"`
	CUDAArchitecture  string `json:"cudaArchitecture"`
}

func Detect() ([]Info, error) {
	cmd := exec.Command(
		"nvidia-smi",
		"--query-gpu=uuid,name,memory.total,memory.used,utilization.gpu,temperature.gpu,compute_cap",
		"--format=csv,noheader,nounits",
	)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return ParseNvidiaSMI(output), nil
}

func ParseNvidiaSMI(output []byte) []Info {
	lines := bytes.Split(bytes.TrimSpace(output), []byte("\n"))
	gpus := make([]Info, 0, len(lines))
	for _, line := range lines {
		fields := strings.Split(string(line), ",")
		if len(fields) < 7 {
			continue
		}
		for i := range fields {
			fields[i] = strings.TrimSpace(fields[i])
		}
		gpus = append(gpus, Info{
			ID:                fields[0],
			Name:              fields[1],
			VRAM:              atoi(fields[2]),
			VRAMUsed:          atoi(fields[3]),
			Utilization:       atoi(fields[4]),
			Temperature:       atoi(fields[5]),
			ComputeCapability: fields[6],
			CUDAArchitecture:  ArchFromComputeCapability(fields[6]),
		})
	}
	return gpus
}

func ArchFromComputeCapability(computeCapability string) string {
	parts := strings.Split(strings.TrimSpace(computeCapability), ".")
	if len(parts) == 1 {
		return parts[0]
	}
	if len(parts) < 2 {
		return ""
	}
	return parts[0] + parts[1]
}

func UniqueArchitectures(gpus []Info) []string {
	seen := map[string]bool{}
	var archs []string
	for _, gpu := range gpus {
		if gpu.CUDAArchitecture == "" || seen[gpu.CUDAArchitecture] {
			continue
		}
		seen[gpu.CUDAArchitecture] = true
		archs = append(archs, gpu.CUDAArchitecture)
	}
	return archs
}

func atoi(value string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(value))
	return n
}
