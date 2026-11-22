/** "Nghe thử": plays a short sample of an alarm sound in this browser, with the same synth the phone uses. */
import { audioState, previewSound, unlockAudio, type AlarmSoundKind } from "../../../deck/src/alarm-sound";

export type AlarmSound = AlarmSoundKind;

let stopPrev: (() => void) | null = null;

/** Plays about 4 s of the sound (a new press replaces the previous one). False when WebAudio is missing or the sound is "none". */
export function previewAlarmSound(sound: AlarmSound): boolean {
  unlockAudio();
  if (sound === "none" || audioState() === "unsupported") return false;
  stopPrev?.();
  stopPrev = previewSound(sound);
  return true;
}
