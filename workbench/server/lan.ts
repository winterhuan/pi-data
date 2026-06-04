/**
 * lan.ts — 探测本机局域网 IP
 *
 * 问题: 二维码若用 req.headers.host(浏览器访问时是 localhost),手机扫码打不开
 * (手机上没有 localhost)。手机访问必须用本机局域网 IP。
 *
 * 方案: 从网络接口里挑第一个非内网回环的 IPv4。WSL2 mirrored 网络模式下,
 * 这会是 Windows 主机的局域网 IP(192.168.x.x),手机同网可达。
 * 可被 WORKBENCH_LAN_IP 环境变量覆盖。
 */

import { networkInterfaces } from "node:os";

export function lanIp(): string | null {
  if (process.env.WORKBENCH_LAN_IP) return process.env.WORKBENCH_LAN_IP;
  const ifaces = networkInterfaces();
  // 优先 192.168.* / 10.* / 172.16-31.*(典型家庭/办公局域网)
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      candidates.push(ni.address);
    }
  }
  // 偏好 192.168 段
  return (
    candidates.find((a) => a.startsWith("192.168.")) ??
    candidates.find((a) => a.startsWith("10.")) ??
    candidates[0] ??
    null
  );
}

/** 把 host 里的 localhost/127.0.0.1 换成局域网 IP,保留端口。 */
export function lanHost(host: string): string {
  const ip = lanIp();
  if (!ip) return host;
  const port = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : "7777";
  return `${ip}:${port}`;
}
