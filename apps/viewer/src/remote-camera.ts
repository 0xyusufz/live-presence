export class RemoteCameraMedia {
  private track: MediaStreamTrack | undefined;
  private enabled = false;
  private visibleTrack: MediaStreamTrack | undefined;
  private readonly onStream: (stream: MediaStream | undefined) => void;
  private readonly detachVideo: () => void;
  private readonly createStream: (track: MediaStreamTrack) => MediaStream;

  constructor(options: {
    onStream: (stream: MediaStream | undefined) => void;
    detachVideo: () => void;
    createStream?: (track: MediaStreamTrack) => MediaStream;
  }) {
    this.onStream = options.onStream;
    this.detachVideo = options.detachVideo;
    this.createStream = options.createStream ?? ((track) => new MediaStream([track]));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.sync();
  }

  setTrack(track: MediaStreamTrack | undefined): void {
    if (this.track === track) return;
    this.removeTrackListeners();
    this.track = track;
    if (track) {
      track.addEventListener("mute", this.onTrackStateChange);
      track.addEventListener("unmute", this.onTrackStateChange);
      track.addEventListener("ended", this.onTrackEnded);
    }
    this.sync();
  }

  clear(): void {
    this.enabled = false;
    this.setTrack(undefined);
  }

  private readonly onTrackStateChange = (): void => this.sync();

  private readonly onTrackEnded = (): void => {
    const track = this.track;
    if (track) this.setTrack(undefined);
  };

  private removeTrackListeners(): void {
    this.track?.removeEventListener("mute", this.onTrackStateChange);
    this.track?.removeEventListener("unmute", this.onTrackStateChange);
    this.track?.removeEventListener("ended", this.onTrackEnded);
  }

  private sync(): void {
    const track = this.track;
    if (!this.enabled || !track || track.readyState !== "live" || track.muted) {
      if (this.visibleTrack) {
        this.visibleTrack = undefined;
        this.detachVideo();
        this.onStream(undefined);
      }
      return;
    }
    if (this.visibleTrack === track) return;
    this.visibleTrack = track;
    this.onStream(this.createStream(track));
  }
}
