import { execFile } from 'node:child_process'
import { join } from 'node:path'

export interface WindowsCredential {
  userName: string
  comment?: string
  persist: number
  blob: Buffer
}

const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AntigravityCredential {
  private const string Target = "gemini:antigravity";
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Credential {
    public uint Flags, Type;
    public string TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", ExactSpelling = true, CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr credential);

  public sealed class Entry {
    public string userName { get; set; }
    public string comment { get; set; }
    public uint persist { get; set; }
    public string blob { get; set; }
  }

  public static Entry Read() {
    IntPtr p;
    if (!CredReadW(Target, 1, 0, out p)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      var c = (Credential)Marshal.PtrToStructure(p, typeof(Credential));
      var bytes = new byte[c.CredentialBlobSize];
      if (bytes.Length > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      return new Entry { userName = c.UserName ?? "", comment = c.Comment, persist = c.Persist, blob = Convert.ToBase64String(bytes) };
    } finally { CredFree(p); }
  }

  public static void Write(string user, string comment, uint persist, byte[] bytes) {
    var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
    try {
      var c = new Credential {
        TargetName = Target, Type = 1, UserName = user, Comment = comment, Persist = persist,
        CredentialBlobSize = (uint)bytes.Length,
        CredentialBlob = bytes.Length == 0 ? IntPtr.Zero : pin.AddrOfPinnedObject()
      };
      if (!CredWriteW(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { pin.Free(); }
  }

  public static bool CompareAndWrite(string expected, string next) {
    var current = Read();
    if (current == null || !String.Equals(current.blob, expected, StringComparison.Ordinal)) return false;
    Write(current.userName, current.comment, current.persist, Convert.FromBase64String(next));
    return true;
  }
}
'@
$entry = [Console]::In.ReadToEnd()
if ($entry.Length -eq 0) {
  $data = [AntigravityCredential]::Read()
  if ($null -ne $data) { $data | ConvertTo-Json -Compress }
} else {
  $data = ConvertFrom-Json -InputObject $entry
  if ($null -ne $data.expected) {
    if ([AntigravityCredential]::CompareAndWrite($data.expected, $data.next)) { 'true' } else { 'false' }
  } else {
    $comment = $data.comment
    if ($null -eq $comment) { $comment = [NullString]::Value }
    [AntigravityCredential]::Write($data.userName, $comment, $data.persist, [Convert]::FromBase64String($data.blob))
  }
}
`

function run(operation: '读取' | '写入', input = ''): Promise<string> {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    const fail = (): void => reject(new Error(`无法${operation} Antigravity 的 Windows 凭据`))
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 15_000
    }, (error, stdout) => error ? fail() : resolve(stdout.trim()))
    child.stdin?.once('error', fail)
    child.stdin?.end(input, 'utf8')
  })
}

export async function readAntigravityCredential(): Promise<WindowsCredential | undefined> {
  if (process.platform !== 'win32') return undefined
  const output = await run('读取')
  if (!output) return undefined
  try {
    const { userName, comment, persist, blob } = JSON.parse(output)
    return { userName, comment: comment ?? undefined, persist, blob: Buffer.from(blob, 'base64') }
  } catch {
    throw new Error('无法解析 Antigravity 的 Windows 凭据')
  }
}

export async function writeAntigravityCredential(entry: WindowsCredential): Promise<void> {
  if (process.platform !== 'win32') throw new Error('仅 Windows 支持写入 Antigravity 系统凭据')
  await run('写入', JSON.stringify({ ...entry, blob: entry.blob.toString('base64') }))
}

/** Call under the main-process transaction lock; external writers are not locked. */
export async function compareAndWriteAntigravityCredential(expected: Buffer, next: Buffer): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const output = await run('写入', JSON.stringify({ expected: expected.toString('base64'), next: next.toString('base64') }))
  if (output === 'true') return true
  if (output === 'false') return false
  throw new Error('无法确认 Antigravity 的 Windows 凭据写入结果')
}
