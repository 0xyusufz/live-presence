export class ViewerStartupConnection {
  private started = false;
  private disconnected = false;

  start(deviceId: string, connect: (deviceId: string) => void): void {
    const selectedDeviceId = deviceId.trim();
    if (this.started || this.disconnected || !selectedDeviceId) return;
    this.started = true;
    connect(selectedDeviceId);
  }

  disconnect(): void {
    this.disconnected = true;
  }
}
