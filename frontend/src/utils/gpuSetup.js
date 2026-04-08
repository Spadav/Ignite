export function getGpuSetupUi(dockerGpu, gpu) {
  const gpuVisible = Boolean(
    gpu?.available ||
    (Array.isArray(gpu?.gpus) && gpu.gpus.length > 0) ||
    Number(gpu?.memory_total_gb || 0) > 0
  )

  if (gpuVisible || dockerGpu?.state === 'ready') {
    return {
      state: 'ready',
      title: 'GPU Ready',
      message: 'Ignite can use your NVIDIA GPU for llama.cpp models.',
      nextStep: 'No extra setup is needed.',
    }
  }

  switch (dockerGpu?.state) {
    case 'docker_missing':
      return {
        state: 'docker_missing',
        title: 'Docker Not Installed',
        message: 'Install Docker before Ignite can start local AI containers.',
        nextStep: 'Install Docker, then start Ignite again.',
      }
    case 'docker_unreachable':
      return {
        state: 'docker_unreachable',
        title: 'Docker Not Running',
        message: 'Ignite cannot talk to Docker on this computer right now.',
        nextStep: 'Start Docker, then refresh Ignite.',
      }
    case 'host_gpu_missing':
      return {
        state: 'host_gpu_missing',
        title: 'No NVIDIA GPU Found',
        message: 'Ignite could not find NVIDIA GPU tools on this computer.',
        nextStep: 'Install NVIDIA drivers and confirm `nvidia-smi` works on the host.',
      }
    case 'docker_gpu_not_ready':
      return {
        state: 'docker_gpu_not_ready',
        title: 'GPU Setup Needed',
        message: 'Ignite can run, but Docker cannot use your NVIDIA GPU yet.',
        nextStep: 'Install NVIDIA Container Toolkit on the host, then restart Docker.',
      }
    case 'containerized':
      return {
        state: 'containerized',
        title: 'GPU Setup Check',
        message: 'Ignite cannot verify host GPU setup automatically from inside Docker.',
        nextStep: 'If GPU models fail to start, install NVIDIA Container Toolkit on the host and restart Docker.',
      }
    default:
      return {
        state: 'unknown',
        title: 'Checking GPU Setup',
        message: dockerGpu?.message || 'Ignite is still checking whether Docker can use your GPU.',
        nextStep: 'Wait a moment, then refresh the page.',
      }
  }
}

export function getLinuxGpuSetupCommands() {
  return [
    'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --dearmor | sudo tee /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg >/dev/null',
    'curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed \'s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g\' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null',
    'sudo apt-get update',
    'sudo apt-get install -y nvidia-container-toolkit',
    'sudo nvidia-ctk runtime configure --runtime=docker',
    'sudo systemctl restart docker',
    'docker run --rm --gpus all --entrypoint sh ghcr.io/ggml-org/llama.cpp:server-cuda -lc \'nvidia-smi -L\'',
  ]
}
