import {Audio} from '@remotion/media';
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import './style.css';

const colors = {
  bg: '#05050b',
  ink: '#f4f1ea',
  muted: '#8c889a',
  gold: '#d8ae47',
  red: '#ba2a38',
  violet: '#8c55d8',
  blue: '#aebcff',
};

type Beat = {
  at: number;
  duration: number;
  eyebrow?: string;
  title: string;
  subtitle?: string;
  tone?: 'gold' | 'red' | 'violet' | 'blue' | 'white';
};

const beats: Beat[] = [
  {at: 1, duration: 4.8, eyebrow: 'The archive', title: 'THREADBONER', subtitle: 'Some records remain sealed.', tone: 'gold'},
  {at: 6.2, duration: 4.6, eyebrow: 'Every bond', title: 'leaves a Thread.', subtitle: 'Fate. Memory. Emotion. Reality.', tone: 'blue'},
  {at: 11.4, duration: 4.4, eyebrow: 'Then came', title: 'The Unraveling.', subtitle: 'The world forgot its own connections.', tone: 'red'},
  {at: 16.6, duration: 4.8, eyebrow: 'One name', title: 'waits in the margins.', subtitle: 'The account is not yet complete.', tone: 'white'},
  {at: 22.1, duration: 4.7, eyebrow: 'A boundary', title: 'holds its breath.', subtitle: 'Something waits on the other side.', tone: 'gold'},
  {at: 27.5, duration: 4.1, eyebrow: 'Some promises', title: 'do not stay broken.', subtitle: 'The marks remember.', tone: 'red'},
  {at: 33, duration: 4.7, eyebrow: 'Somewhere nearby', title: 'a witness remains.', subtitle: 'No one has told the whole story.', tone: 'violet'},
  {at: 39, duration: 4.5, eyebrow: 'The sealed archive', title: 'is still listening.', subtitle: 'Some records are not ready to open.', tone: 'blue'},
  {at: 44.3, duration: 4.1, eyebrow: 'Follow the thread', title: 'find what remains.', subtitle: 'The archive is incomplete by design.', tone: 'red'},
];

const powerWords = [
  'TIME SLOWS',
  'DAMAGE DENIED',
  'RULE MAKER',
  'THREAD CUT',
  'BLOOM ABSOLUTE',
  'ONE MORE REASON',
];

const impactSeconds = [1, 6.2, 11.4, 16.6, 22.1, 27.5, 30.1, 32.2, 33, 35.1, 37.2, 39, 41.1, 44.3, 46.4, 49.6];

const toneColor = (tone: Beat['tone']) => {
  if (tone === 'red') {
    return colors.red;
  }
  if (tone === 'violet') {
    return colors.violet;
  }
  if (tone === 'blue') {
    return colors.blue;
  }
  if (tone === 'white') {
    return colors.ink;
  }
  return colors.gold;
};

const clampProgress = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], {
    easing: Easing.bezier(0.16, 1, 0.3, 1),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const seeded = (index: number, salt = 0) => {
  const x = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const ParticleField = () => {
  const frame = useCurrentFrame();
  const dots = Array.from({length: 210}, (_, i) => {
    const x = seeded(i, 1) * 1920;
    const y = seeded(i, 2) * 1080;
    const size = 1 + seeded(i, 3) * 5.5;
    const drift = ((frame * (0.46 + seeded(i, 4) * 1.35)) + y) % 1080;
    const opacity = 0.22 + seeded(i, 5) * 0.74;

    return (
      <span
        className="particle"
        key={i}
        style={{
          left: x,
          top: drift,
          width: size,
          height: size,
          opacity,
          backgroundColor: seeded(i, 6) > 0.78 ? colors.gold : colors.blue,
        }}
      />
    );
  });

  return <div className="particleField">{dots}</div>;
};

const ThreadWeb = ({intensity = 1}: {intensity?: number}) => {
  const frame = useCurrentFrame();
  const threads = Array.from({length: 72}, (_, i) => {
    const top = 120 + seeded(i, 8) * 840;
    const width = 420 + seeded(i, 9) * 1260;
    const left = -360 + seeded(i, 10) * 2500;
    const rotate = -42 + seeded(i, 11) * 84;
    const phase = Math.sin(frame * 0.055 + i) * 48;
    const opacity = (0.12 + seeded(i, 12) * 0.48) * intensity;

    return (
      <span
        className="thread"
        key={i}
        style={{
          left,
          top: top + phase,
          width,
          opacity,
          transform: `rotate(${rotate}deg)`,
          background: `linear-gradient(90deg, transparent, ${colors.gold}, ${colors.blue}, transparent)`,
        }}
      />
    );
  });

  return <div className="threadWeb">{threads}</div>;
};

const CovenantDoor = () => {
  const frame = useCurrentFrame();
  const pulse = interpolate(Math.sin(frame * 0.14), [-1, 1], [0.78, 1.22]);

  return (
    <div className="doorWrap" style={{transform: `scale(${pulse})`}}>
      <div className="doorRing doorRingOuter" />
      <div className="doorRing doorRingInner" />
      <div className="doorVoid" />
      {Array.from({length: 32}, (_, i) => (
        <span
          className="doorRune"
          key={i}
          style={{transform: `rotate(${i * 11.25 + frame * 0.46}deg) translateY(-232px)`}}
        />
      ))}
    </div>
  );
};

const CoverReveal = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = clampProgress(frame, 0, 1.2 * fps);
  const float = Math.sin(frame * 0.08) * 22;

  return (
    <div className="coverStage" style={{opacity: enter}}>
      <Img
        className="cover coverBack"
        src={staticFile('volume2-cover.jpg')}
        style={{transform: `translate(-58%, -49%) rotate(-11deg) scale(${0.72 + enter * 0.22})`}}
      />
      <Img
        className="cover coverFront"
        src={staticFile('volume1-cover.png')}
        style={{transform: `translate(-50%, calc(-50% + ${float}px)) rotate(4deg) scale(${0.78 + enter * 0.2})`}}
      />
    </div>
  );
};

const BeatCard = ({beat}: {beat: Beat}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - beat.at * fps;
  const inP = clampProgress(local, 0, 0.45 * fps);
  const outP = clampProgress(local, (beat.duration - 0.52) * fps, beat.duration * fps);
  const impact = clampProgress(local, 0, 0.1 * fps) - clampProgress(local, 0.26 * fps, 0.56 * fps);
  const visible = Math.max(0, inP - outP);
  const accent = toneColor(beat.tone);
  const shake = Math.sin(local * 2.3) * impact * 16;
  const y = interpolate(inP, [0, 1], [72, 0]) + interpolate(outP, [0, 1], [0, -46]);
  const scale = interpolate(inP, [0, 1], [1.16, 1]) + impact * 0.045;

  return (
    <Sequence from={beat.at * fps} durationInFrames={beat.duration * fps}>
      <div
        className="beatCard"
        style={{
          opacity: visible,
          transform: `translate(${shake}px, ${y}px) scale(${scale})`,
          filter: `contrast(${1 + impact * 0.5})`,
        }}
      >
        {beat.eyebrow ? <div className="eyebrow" style={{color: accent}}>{beat.eyebrow}</div> : null}
        <div className="beatTitle" style={{textShadow: `0 0 34px ${accent}`}}>{beat.title}</div>
        {beat.subtitle ? <div className="beatSubtitle">{beat.subtitle}</div> : null}
        <div className="accentLine" style={{backgroundColor: accent}} />
      </div>
    </Sequence>
  );
};

const PowerMontage = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <Sequence from={26 * fps} durationInFrames={23 * fps}>
      <div className="powerGrid">
        {powerWords.map((word, i) => {
          const local = frame - 26 * fps - i * 2.15 * fps;
          const flash = clampProgress(local, 0, 0.18 * fps) - clampProgress(local, 0.82 * fps, 1.18 * fps);
          const color = [colors.blue, colors.red, colors.gold, colors.ink, colors.violet, colors.gold][i];

          return (
            <div
              className="powerWord"
              key={word}
              style={{
                color,
                opacity: Math.max(0, flash),
                transform: `translateY(${interpolate(flash, [0, 1], [62, 0])}px) scale(${interpolate(flash, [0, 1], [1.34, 1])}) rotate(${Math.sin(local * 0.4) * 1.4}deg)`,
              }}
            >
              {word}
            </div>
          );
        })}
      </div>
    </Sequence>
  );
};

const LogoFinale = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - 49.6 * fps;
  const glow = clampProgress(local, 0, 0.8 * fps);
  const fade = clampProgress(local, 6.2 * fps, 8.4 * fps);

  return (
    <Sequence from={49.6 * fps} durationInFrames={8.4 * fps}>
      <div className="finale" style={{opacity: Math.max(0, glow - fade)}}>
        <div className="finaleTitle">THREADBONER</div>
        <div className="finaleTag">The archive is incomplete by design.</div>
        <div className="comingSoon">Follow the thread</div>
      </div>
    </Sequence>
  );
};

const SceneAtmosphere = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const danger = clampProgress(frame, 10.8 * fps, 14.2 * fps) - clampProgress(frame, 29 * fps, 32 * fps);
  const violet = clampProgress(frame, 32 * fps, 34 * fps) - clampProgress(frame, 39 * fps, 42 * fps);
  const door = clampProgress(frame, 16 * fps, 19.5 * fps) - clampProgress(frame, 31 * fps, 34 * fps);

  return (
    <>
      <div className="baseWash" />
      <div className="redWash" style={{opacity: danger * 0.72}} />
      <div className="violetWash" style={{opacity: violet * 0.6}} />
      <SpeedLines />
      <ThreadWeb intensity={0.82 + danger * 1.55 + violet * 1.15} />
      <ParticleField />
      <div className="doorScene" style={{opacity: door}}>
        <CovenantDoor />
      </div>
    </>
  );
};

const SpeedLines = () => {
  const frame = useCurrentFrame();
  const lines = Array.from({length: 28}, (_, i) => {
    const top = seeded(i, 30) * 1080;
    const left = ((seeded(i, 31) * 1920 + frame * (18 + seeded(i, 32) * 42)) % 2320) - 260;
    const opacity = 0.08 + seeded(i, 33) * 0.28;

    return (
      <span
        className="speedLine"
        key={i}
        style={{
          left,
          top,
          width: 180 + seeded(i, 34) * 460,
          opacity,
          transform: `rotate(${-10 + seeded(i, 35) * 20}deg)`,
        }}
      />
    );
  });

  return <div className="speedLines">{lines}</div>;
};

const ImpactFlashes = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const flash = impactSeconds.reduce((sum, second, i) => {
    const local = frame - second * fps;
    const burst = clampProgress(local, 0, 0.05 * fps) - clampProgress(local, 0.1 * fps, 0.32 * fps);
    return sum + Math.max(0, burst) * (i % 3 === 0 ? 0.72 : 0.42);
  }, 0);
  const redFlash = impactSeconds.reduce((sum, second, i) => {
    const local = frame - (second + 0.08) * fps;
    const burst = clampProgress(local, 0, 0.04 * fps) - clampProgress(local, 0.08 * fps, 0.22 * fps);
    return sum + Math.max(0, burst) * (i % 2 === 0 ? 0.3 : 0.16);
  }, 0);

  return (
    <>
      <div className="whiteFlash" style={{opacity: Math.min(flash, 0.82)}} />
      <div className="bloodFlash" style={{opacity: Math.min(redFlash, 0.46)}} />
    </>
  );
};

export const ThreadbornTrailer = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const coverOpacity = clampProgress(frame, 0, 1.1 * fps) - clampProgress(frame, 8.6 * fps, 11.8 * fps);
  const endFade = clampProgress(frame, durationInFrames - 1.25 * fps, durationInFrames);

  return (
    <AbsoluteFill className="trailer">
      <Audio
        src={staticFile('licensed-trailer-audio.mp3')}
        volume={(audioFrame) =>
          interpolate(audioFrame, [0, 0.9 * fps, 52 * fps, 57.5 * fps], [0, 0.56, 0.56, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />
      <SceneAtmosphere />
      <div className="coverLayer" style={{opacity: coverOpacity}}>
        <CoverReveal />
      </div>
      {beats.map((beat) => (
        <BeatCard beat={beat} key={`${beat.at}-${beat.title}`} />
      ))}
      <PowerMontage />
      <LogoFinale />
      <ImpactFlashes />
      <div className="vignette" />
      <div className="letterbox top" />
      <div className="letterbox bottom" />
      <div className="fadeToBlack" style={{opacity: endFade}} />
    </AbsoluteFill>
  );
};
