// ── Stream reader (control stream + uni streams) ───────────────────────────
export class BufReader {
  constructor() {
    this.chunks = [];
    this.totalBuf = new Uint8Array(0);
    this.pos = 0;
    this.waiters = [];
  }

  feed(chunk) {
    // Append chunk to buffer
    const newBuf = new Uint8Array(
      this.totalBuf.length - this.pos + chunk.length,
    );
    newBuf.set(this.totalBuf.slice(this.pos), 0);
    newBuf.set(chunk, this.totalBuf.length - this.pos);
    this.totalBuf = newBuf;
    this.pos = 0;
    // Wake waiting readers
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      resolve();
    }
  }

  async _ensureBytes(n) {
    while (this.pos + n > this.totalBuf.length) {
      await new Promise((r) => this.waiters.push(r));
    }
  }

  async readByte() {
    await this._ensureBytes(1);
    return this.totalBuf[this.pos++];
  }

  async readVarint() {
    const first = await this.readByte();
    const lenCode = (first >> 6) & 0x3;
    if (lenCode === 0) return first & 0x3f;
    const extra = [0, 1, 3, 7][lenCode];
    let val = first & 0x3f;
    for (let i = 0; i < extra; i++) {
      val = val * 256 + (await this.readByte());
    }
    return val;
  }

  async readU16() {
    const hi = await this.readByte();
    const lo = await this.readByte();
    return (hi << 8) | lo;
  }

  async readBytes(n) {
    await this._ensureBytes(n);
    const out = this.totalBuf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  async readString() {
    const len = await this.readVarint();
    const bytes = await this.readBytes(len);
    return new TextDecoder().decode(bytes);
  }
}
