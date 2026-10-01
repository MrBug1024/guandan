import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Request, Response } from 'express';

export async function createAccess(directory = 'data') {
  const path = `${directory}/admin.json`;
  let account: {
    username: string;
    salt: string;
    hash: string;
    share: string;
    encryptionKey: string;
  };
  try {
    account = JSON.parse(await readFile(path, 'utf8'));
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const salt = randomBytes(16).toString('hex');
    account = {
      username: 'ymtadmin',
      salt,
      hash: scryptSync('ymthcx3344520', salt, 64).toString('hex'),
      share: randomBytes(24).toString('hex'),
      encryptionKey: randomBytes(32).toString('hex'),
    };
    await writeFile(path, JSON.stringify(account), { mode: 0o600, flag: 'wx' });
  }
  const sessions = new Map<string, number>();
  const attempts = new Map<string, { count: number; until: number }>();
  function session(req: Request) {
    const id = /(?:^|;\s*)gd_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (!id) return false;
    const expires = sessions.get(id);
    if (!expires || expires < Date.now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  }
  function login(req: Request, res: Response) {
    const ip = req.ip ?? 'unknown';
    const limit = attempts.get(ip);
    if (limit && limit.until > Date.now() && limit.count >= 8) {
      res.status(429).json({ error: '登录尝试过多，请 15 分钟后重试' });
      return;
    }
    const { username, password } = req.body ?? {};
    if (typeof password !== 'string' || password.length > 200 || typeof username !== 'string') {
      res.status(400).json({ error: '登录信息不正确' });
      return;
    }
    const hash = scryptSync(password, account.salt, 64);
    if (username !== account.username || !timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) {
      attempts.set(ip, {
        count: (limit && limit.until > Date.now() ? limit.count : 0) + 1,
        until: Date.now() + 900000,
      });
      res.status(401).json({ error: '账号或密码错误' });
      return;
    }
    attempts.delete(ip);
    for (const [id, expires] of sessions) if (expires < Date.now()) sessions.delete(id);
    const id = randomBytes(32).toString('hex');
    sessions.set(id, Date.now() + 12 * 3600000);
    res.cookie('gd_session', id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
      maxAge: 12 * 3600000,
      path: '/',
    });
    res.json({
      authenticated: true,
      username: account.username,
      sharePath: `/watch/${account.share}`,
    });
  }
  function logout(req: Request, res: Response) {
    const id = /(?:^|;\s*)gd_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if (id) sessions.delete(id);
    res.clearCookie('gd_session', { path: '/' });
    res.json({ ok: true });
  }
  const viewer = (req: Request) =>
    session(req) || (typeof req.query.share === 'string' && req.query.share === account.share);
  function encrypt(value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', Buffer.from(account.encryptionKey, 'hex'), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return {
      encrypted: true,
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  function decrypt(value: any) {
    if (!value.encrypted) return value;
    const cipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(account.encryptionKey, 'hex'),
      Buffer.from(value.iv, 'hex'),
    );
    cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(value.ciphertext, 'base64')),
        cipher.final(),
      ]).toString(),
    );
  }
  return {
    session,
    login,
    logout,
    viewer,
    encrypt,
    decrypt,
    info: { username: account.username, sharePath: `/watch/${account.share}` },
  };
}
