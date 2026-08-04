import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlist } from '../src/service/launchd';
import { buildUnit, SYSTEMD_UNIT_NAME } from '../src/service/systemd';
import { buildLauncherCmd, buildLauncherVbs } from '../src/service/win-startup';

// The systemd unit (Linux/WSL) and the Windows hidden-launcher .cmd/.vbs are
// generated text that can't be exercised on the mac dev box — lock their shape
// here so a refactor can't silently break the daemon definitions.

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('launchd plist (buildPlist)', () => {
  it('runs the configured service wrapper instead of the Node CLI', () => {
    vi.stubEnv(
      'FEISHU_CODEX_BRIDGE_SERVICE_WRAPPER',
      '/Users/test user/.feishu-codex-bridge/workspace/gbrain/run_feishu_bot.sh',
    );

    const plist = buildPlist();

    expect(plist).toContain(
      '<string>/Users/test user/.feishu-codex-bridge/workspace/gbrain/run_feishu_bot.sh</string>',
    );
    expect(plist).not.toContain('<string>run</string>');
  });
});

describe('systemd unit (buildUnit)', () => {
  it('is a well-formed user service with crash-restart + login autostart', () => {
    const unit = buildUnit();
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('runs the bridge `run` subcommand and appends to the shared log files', () => {
    const unit = buildUnit();
    expect(unit).toMatch(/ExecStart=".+" ".+" run/);
    expect(unit).toContain('StandardOutput=append:');
    expect(unit).toContain('StandardError=append:');
    expect(unit).toContain('Environment="PATH=');
  });

  it('unit name is a .service', () => {
    expect(SYSTEMD_UNIT_NAME).toMatch(/\.service$/);
  });

  it('runs the configured service wrapper instead of the Node CLI', () => {
    vi.stubEnv(
      'FEISHU_CODEX_BRIDGE_SERVICE_WRAPPER',
      '/home/test user/.feishu-codex-bridge/workspace/gbrain/run_feishu_bot.sh',
    );

    const unit = buildUnit();

    expect(unit).toContain(
      'ExecStart="/home/test user/.feishu-codex-bridge/workspace/gbrain/run_feishu_bot.sh"',
    );
    expect(unit).not.toMatch(/ExecStart=".+" ".+" run/);
  });
});

describe('Windows hidden launcher (.cmd)', () => {
  const cmd = buildLauncherCmd();

  it('is a CRLF batch script that sets PATH + service flag and runs the bridge', () => {
    expect(cmd.startsWith('@echo off')).toBe(true);
    expect(cmd).toContain('\r\n'); // cmd.exe needs CRLF
    expect(cmd).toContain('set "PATH=');
    expect(cmd).toContain('set "FEISHU_CODEX_BRIDGE_SERVICE=1"');
    expect(cmd).toMatch(/".+" ".+" run /);
  });

  it('appends stdout and stderr to the log files', () => {
    expect(cmd).toContain('>> "');
    expect(cmd).toContain('2>> "');
  });
});

describe('Windows hidden launcher (.vbs)', () => {
  const vbs = buildLauncherVbs();

  it('runs the .cmd hidden (window style 0) and does not wait', () => {
    expect(vbs).toContain('WScript.Shell');
    expect(vbs).toMatch(/sh\.Run "cmd \/c "".+\.cmd""", 0, False/);
  });
});
