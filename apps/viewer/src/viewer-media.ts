const MAX_PLAY_ATTEMPTS = 3;

export class VideoPlayback {
  private video: HTMLVideoElement | undefined;
  private stream: MediaStream | undefined;
  private detachMediaListeners: (() => void) | undefined;

  setVideo(video: HTMLVideoElement | null): void {
    if (this.video === video) return;
    this.detachMediaListeners?.();
    this.detachMediaListeners = undefined;
    const previousVideo = this.video;
    if (previousVideo && previousVideo.srcObject === this.stream) previousVideo.srcObject = null;
    this.video = video ?? undefined;
    this.attach();
  }

  setStream(stream: MediaStream | undefined): void {
    if (this.stream === stream) return;
    this.detachMediaListeners?.();
    this.detachMediaListeners = undefined;
    const video = this.video;
    if (video && video.srcObject === this.stream) video.srcObject = null;
    this.stream = stream;
    this.attach();
  }

  clear(): void {
    this.setStream(undefined);
    this.setVideo(null);
  }

  private attach(): void {
    const video = this.video;
    const stream = this.stream;
    if (!video || !stream) return;

    video.muted = true;
    video.srcObject = stream;
    let active = true;
    let playbackStarted = false;
    let playPending = false;
    let playAttempts = 0;
    const tracks = new Set<MediaStreamTrack>();

    const onPlaying = () => {
      playbackStarted = true;
    };
    const tryPlay = () => {
      if (
        !active ||
        playbackStarted ||
        playPending ||
        playAttempts >= MAX_PLAY_ATTEMPTS ||
        video.srcObject !== stream
      ) return;

      playAttempts += 1;
      playPending = true;
      try {
        void video.play().then(
          () => {
            if (active && video.srcObject === stream) playbackStarted = true;
            playPending = false;
          },
          () => {
            playPending = false;
          },
        );
      } catch {
        playPending = false;
      }
    };
    const onTrackAvailable = () => tryPlay();
    const addTrackListeners = (track: MediaStreamTrack) => {
      if (tracks.has(track)) return;
      tracks.add(track);
      track.addEventListener("unmute", onTrackAvailable);
    };
    const onAddTrack = (event: Event) => {
      const track = (event as MediaStreamTrackEvent).track;
      if (track) addTrackListeners(track);
      tryPlay();
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("loadedmetadata", tryPlay);
    video.addEventListener("canplay", tryPlay);
    stream.addEventListener("addtrack", onAddTrack);
    for (const track of stream.getTracks()) addTrackListeners(track);

    this.detachMediaListeners = () => {
      active = false;
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("loadedmetadata", tryPlay);
      video.removeEventListener("canplay", tryPlay);
      stream.removeEventListener("addtrack", onAddTrack);
      for (const track of tracks) track.removeEventListener("unmute", onTrackAvailable);
      if (video.srcObject === stream) video.srcObject = null;
    };

    tryPlay();
  }
}

export function stopViewerMediaTracks(...streams: Array<MediaStream | undefined>): void {
  for (const stream of streams) {
    stream?.getTracks().forEach((track) => track.stop());
  }
}
