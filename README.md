# Claude Code Notifier

Claude Code가 **선택창(AskUserQuestion)** 이나 **권한 승인창(Allow/Deny)** 을 띄우기 직전에 소리를 재생하는 VS Code 익스텐션입니다.

다른 작업 중이어도 소리를 듣고 Claude Code가 입력을 기다리고 있다는 걸 바로 알 수 있어요.

---

## 설치

### 1. VSIX 파일 설치

[Releases](../../releases)에서 최신 `.vsix` 파일을 다운로드 후:

```bash
code --install-extension claude-notifier-x.x.x.vsix
```

또는 VS Code에서 `Ctrl+Shift+P` → **Extensions: Install from VSIX** → 파일 선택

### 2. Hook 설정 (필수)

`~/.claude/settings.json` 에 아래 내용을 추가하세요.

**Windows:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -Command \"'' | Out-File -FilePath '$env:USERPROFILE\\.claude\\notifier-trigger' -Force\""
          }
        ]
      }
    ]
  }
}
```

**macOS / Linux:**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "touch ~/.claude/notifier-trigger"
          }
        ]
      }
    ]
  }
}
```

> AskUserQuestion 창만 감지하고 싶다면 `"matcher": ".*"` 를 `"matcher": "AskUserQuestion"` 으로 변경하세요.

---

## 사용법

설치 후 VS Code를 재시작하면 상태바 우측에 `🔔 Claude` 가 표시됩니다.

| 명령어 | 설명 |
|--------|------|
| `Claude Notifier: Select Sound File` | mp3, wav, ogg 등 커스텀 사운드 파일 선택 |
| `Claude Notifier: Test Sound` | 현재 설정된 소리 미리 재생 |
| `Claude Notifier: Toggle On/Off` | 알림 켜기/끄기 (상태바 클릭도 가능) |

---

## 설정

| 설정값 | 기본값 | 설명 |
|--------|--------|------|
| `claudeNotifier.soundPath` | `""` | 커스텀 사운드 파일 경로 (비어있으면 내장 비프음) |
| `claudeNotifier.enabled` | `true` | 알림 활성화 여부 |
| `claudeNotifier.volume` | `0.8` | 볼륨 (0.0 ~ 1.0) |
| `claudeNotifier.cooldownMs` | `3000` | 연속 알림 방지 최소 간격 (ms) |
| `claudeNotifier.alsoNotify` | `true` | VS Code 알림 배너도 함께 표시 |

---

## 작동 원리

```
Claude Code가 도구 호출
       ↓
~/.claude/settings.json hook 실행
       ↓
~/.claude/notifier-trigger 파일 터치
       ↓
익스텐션이 150ms 폴링으로 감지
       ↓
소리 재생 🔔
       ↓
Claude Code가 선택창 / 권한창 표시
```

---

## 소리 파일이 없을 때

커스텀 파일을 설정하지 않으면 OS 내장 비프음이 재생됩니다.
- **Windows**: `[console]::beep()` (880Hz → 660Hz 2음 차임)
- **macOS**: `afplay /System/Library/Sounds/Ping.aiff`
- **Linux**: `paplay` / PulseAudio

---

## 개발 / 빌드

```bash
git clone https://github.com/<your-username>/claude-notifier
cd claude-notifier
npm install
npx tsc -p ./
npx vsce package --no-dependencies
```
