# The Raspberry Pi image leaves out the runtimes it never uses: the Hailo and MemryX
# accelerators, the generic ffmpeg builds (it runs its own, /usr/lib/ffmpeg/rpi) and the
# OpenVINO model. The Coral (Edge TPU) runtime, the CPU and audio models stay.
# docker/main/Dockerfile lists the switches; other images keep the defaults.
target deps {
  dockerfile = "docker/main/Dockerfile"
  platforms = ["linux/arm64"]
  target = "deps"
  args = {
    INSTALL_HAILO = "false"
    INSTALL_MEMRYX = "false"
    INSTALL_GENERIC_FFMPEG = "false"
    OPENVINO_MODEL = "skip"
  }
}

target rootfs {
  dockerfile = "docker/main/Dockerfile"
  platforms = ["linux/arm64"]
  target = "rootfs"
}

target rpi {
  dockerfile = "docker/rpi/Dockerfile"
  contexts = {
    deps = "target:deps",
    rootfs = "target:rootfs"
  }
  platforms = ["linux/arm64"]
}