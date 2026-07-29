#include "atch_wire_v3.h"

#include <stdlib.h>
#include <string.h>

static uint16_t u16(const unsigned char *p) { return (uint16_t)p[0] | ((uint16_t)p[1] << 8); }
static uint32_t u32(const unsigned char *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static uint64_t u64(const unsigned char *p) {
    uint64_t v = 0; int i;
    for (i = 7; i >= 0; --i) v = (v << 8) | p[i];
    return v;
}
static void put16(unsigned char *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put32(unsigned char *p, uint32_t v) { int i; for (i = 0; i < 4; ++i) p[i] = (unsigned char)(v >> (8 * i)); }
static void put64(unsigned char *p, uint64_t v) { int i; for (i = 0; i < 8; ++i) p[i] = (unsigned char)(v >> (8 * i)); }
static size_t putstr(unsigned char *p, size_t n, const char *s) { size_t l=strlen(s); if (l>ATCH_V3_MAX_STR16 || n<l+2) return 0; put16(p,(uint16_t)l); memcpy(p+2,s,l); return l+2; }
static int getstr(const unsigned char *p,size_t n,char *out,size_t cap,size_t *used) { size_t l; if(n<2||(l=u16(p))>n-2||l+1>cap)return ATCH_V3_TRUNCATED; memcpy(out,p+2,l);out[l]=0;*used=l+2;return 0; }
static int valid_type(uint16_t t) {
    static const uint16_t a[] = {1,2,3,4,5,6,16,17,18,19,20,21,32,33,34,48,50,51,52,53,64,65,66,67,68,69,70,80,82,83,84};
    size_t i; for (i=0; i<sizeof(a)/sizeof(a[0]); ++i) if (a[i]==t) return 1; return 0;
}

static int fixed_or_tail(size_t n, size_t fixed) { return n < fixed ? ATCH_V3_TRUNCATED : ATCH_V3_OK; }

/* Frozen v3 payload schemas. Keep this switch explicit so new frame types
 * cannot accidentally inherit header-only validation. */
int atch_v3_validate_payload(uint16_t type, const unsigned char *b, size_t n) {
    atch_v3_record record;
    if (!b && n) return ATCH_V3_TRUNCATED;
    switch (type) {
    case 1: return n == 23 ? 0 : ATCH_V3_TRUNCATED;
    case 2: return n >= 27 && (size_t)u16(b + 25) + 27 == n ? 0 : ATCH_V3_TRUNCATED;
    case 3: return n == 106 ? 0 : ATCH_V3_TRUNCATED;
    case 4: case 6: case 34: return n == 0 ? 0 : ATCH_V3_TRUNCATED;
    case 5: return n >= 4 && (size_t)u16(b + 2) + 4 == n ? 0 : ATCH_V3_TRUNCATED;
    case 16: return n >= 29 && atch_v3_decode_record(b, n, &record) == 0 ? 0 : ATCH_V3_TRUNCATED;
    case 17: return n == 16 ? 0 : ATCH_V3_TRUNCATED;
    /* flags u8 + surface_id u32 + blob32 (length u32 + payload).  A
     * one-byte payload is a valid terminal input (notably Enter), so the
     * minimum encoded body is 9 bytes, not 12. */
    case 18: return n >= 9 ? 0 : ATCH_V3_TRUNCATED;
    case 19: return n >= 73 && (size_t)u32(b + 69) == n - 73 ? 0 : ATCH_V3_TRUNCATED;
    case 20: return n == 18 ? 0 : ATCH_V3_TRUNCATED;
    case 21: return n == 16 ? atch_v3_validate_geometry(u16(b + 12), u16(b + 14)) : ATCH_V3_TRUNCATED;
    case 32: return n == 2 && b[0] <= 1 && b[1] <= 1 ? 0 : ATCH_V3_TRUNCATED;
    case 33: return n == 25 && b[0] <= 1 ? 0 : ATCH_V3_TRUNCATED;
    case 48: return fixed_or_tail(n, 25);
    case 50: case 51: return n == 21 ? 0 : ATCH_V3_TRUNCATED;
    case 52: return n == 29 ? 0 : ATCH_V3_TRUNCATED;
    /* 84 TERMINAL_STATE: blob32 (length u32 + payload) carrying the child's
     * live ANSI mode preamble. Connection-local and non-durable, so there is
     * no record_seq/offset to validate — only that the declared blob length
     * matches the body exactly, which keeps a truncated or padded frame from
     * being accepted. An empty preamble is legitimate (no modes set yet). */
    case 84: return n >= 4 && (size_t)u32(b) == n - 4 ? 0 : ATCH_V3_TRUNCATED;
    case 53: return n == 17 ? 0 : ATCH_V3_TRUNCATED;
    case 64: return n >= 76 ? 0 : ATCH_V3_TRUNCATED;
    case 65: return n == 26 ? 0 : ATCH_V3_TRUNCATED;
    case 66: return n == 16 ? 0 : ATCH_V3_TRUNCATED;
    case 67:
        return n >= 12 && u64(b) != 0 ? 0 : ATCH_V3_TRUNCATED;
    case 68: return n >= 22 ? 0 : ATCH_V3_TRUNCATED;
    case 69: return atch_v3_decode_checkpoint_data(b, n, &(atch_v3_checkpoint_data){0});
    case 70: return n >= 18 ? 0 : ATCH_V3_TRUNCATED;
    case 80: return n == 38 ? 0 : ATCH_V3_TRUNCATED;
    case 82: return n == 17 ? 0 : ATCH_V3_TRUNCATED;
    case 83: return n == 5 && !atch_v3_validate_geometry(u16(b + 1), u16(b + 3)) ? 0 : ATCH_V3_TRUNCATED;
    default: return ATCH_V3_UNKNOWN_TYPE;
    }
}

int atch_v3_decode_frame_ex(const unsigned char *b, size_t n, atch_v3_frame *f, int strict) {
    uint32_t flags, len;
    if (n < ATCH_V3_HEADER_LEN) return ATCH_V3_TRUNCATED;
    if (memcmp(b, "ATV3", 4) != 0) return ATCH_V3_BAD_MAGIC;
    if (u16(b + 4) != 3) return ATCH_V3_BAD_VERSION;
    flags = u32(b + 8); len = u32(b + 12);
    if (len > ATCH_V3_MAX_PAYLOAD) return ATCH_V3_PAYLOAD_TOO_LARGE;
    if ((flags & 0xfffffff0u) != 0 && (strict || (flags & 8u))) return ATCH_V3_BAD_FLAGS;
    if ((size_t)len > n - ATCH_V3_HEADER_LEN) return ATCH_V3_TRUNCATED;
    f->type = u16(b + 6); if (strict && !valid_type(f->type)) return ATCH_V3_UNKNOWN_TYPE;
    f->flags = flags; f->payload_length = len;
    f->generation = u32(b + 16); f->sequence = u64(b + 20); f->aux = u64(b + 28);
    f->payload = (unsigned char *)(b + ATCH_V3_HEADER_LEN);
    if (strict) { int rc = atch_v3_validate_payload(f->type, f->payload, f->payload_length); if (rc) return rc; }
    return ATCH_V3_OK;
}
int atch_v3_decode_frame(const unsigned char *b, size_t n, atch_v3_frame *f) { return atch_v3_decode_frame_ex(b,n,f,0); }

size_t atch_v3_encode_header(unsigned char *b, size_t n, uint16_t type, uint32_t flags,
                             uint32_t generation, uint64_t sequence, uint64_t aux, uint32_t len) {
    if (n < ATCH_V3_HEADER_LEN || len > ATCH_V3_MAX_PAYLOAD) return 0;
    memcpy(b, "ATV3", 4); put16(b+4, 3); put16(b+6, type); put32(b+8, flags); put32(b+12, len);
    put32(b+16, generation); put64(b+20, sequence); put64(b+28, aux); return ATCH_V3_HEADER_LEN;
}

uint32_t atch_v3_crc32(const unsigned char *b, size_t n) {
    uint32_t c = 0xffffffffu; size_t i; int k;
    for (i=0; i<n; ++i) { c ^= b[i]; for (k=0;k<8;++k) c = (c & 1) ? 0xedb88320u ^ (c >> 1) : c >> 1; }
    return c ^ 0xffffffffu;
}

int atch_v3_decode_record(const unsigned char *b, size_t n, atch_v3_record *r) {
    uint32_t len, crc;
    if (n < 1+8+4+8+4+4) return ATCH_V3_TRUNCATED;
    len = u32(b+21); if ((size_t)len > n-25-4) return ATCH_V3_TRUNCATED;
    if ((size_t)25 + len + 4 != n) return ATCH_V3_TRUNCATED;
    crc = u32(b+25+len); if (atch_v3_crc32(b, 25+len) != crc) return ATCH_V3_TRUNCATED;
    r->record_type=b[0]; r->record_seq=u64(b+1); r->generation=u32(b+9); r->output_offset=u64(b+13); r->body_length=len; r->body=(unsigned char *)(b+25); return ATCH_V3_OK;
}

int atch_v3_validate_capabilities(uint32_t caps) { return (caps & ~0x3fu) ? ATCH_V3_CAP_UNSUPPORTED : ATCH_V3_OK; }
int atch_v3_validate_geometry(uint16_t rows, uint16_t cols) { return (!rows||rows>1000||!cols||cols>1000||(uint32_t)rows*cols>2000000u) ? ATCH_V3_GEOMETRY_INVALID : ATCH_V3_OK; }
int atch_v3_encode_hello(const atch_v3_hello *v,unsigned char *b,size_t n,size_t *used) { if(n<23||atch_v3_validate_capabilities(v->capabilities))return ATCH_V3_CAP_UNSUPPORTED; put16(b,v->client_version);b[2]=v->peer_role;put32(b+3,v->capabilities);memcpy(b+7,v->incarnation,16);*used=23;return 0; }
int atch_v3_decode_hello(const unsigned char *b,size_t n,atch_v3_hello *v) { if(n!=23)return ATCH_V3_TRUNCATED;v->client_version=u16(b);v->peer_role=b[2];v->capabilities=u32(b+3);if(v->peer_role>2)return ATCH_V3_UNKNOWN_TYPE;memcpy(v->incarnation,b+7,16);return atch_v3_validate_capabilities(v->capabilities); }
int atch_v3_encode_attach(const atch_v3_attach *v,unsigned char *b,size_t n,size_t *used) { size_t z;if(v->role>1||atch_v3_validate_geometry(v->rows,v->cols))return ATCH_V3_GEOMETRY_INVALID;if(n<27)return ATCH_V3_TRUNCATED; b[0]=v->role;put32(b+1,v->prev_generation);put64(b+5,v->last_seen_offset);put64(b+13,v->last_seen_record_seq);put16(b+21,v->rows);put16(b+23,v->cols);z=putstr(b+25,n-25,v->session_id);if(!z)return ATCH_V3_TRUNCATED;*used=25+z;return 0; }
int atch_v3_decode_attach(const unsigned char *b,size_t n,atch_v3_attach *v,char *sid,size_t cap) { size_t z;if(n<27)return ATCH_V3_TRUNCATED;v->role=b[0];v->prev_generation=u32(b+1);v->last_seen_offset=u64(b+5);v->last_seen_record_seq=u64(b+13);v->rows=u16(b+21);v->cols=u16(b+23);if(v->role>1)return ATCH_V3_UNKNOWN_TYPE;if(atch_v3_validate_geometry(v->rows,v->cols))return ATCH_V3_GEOMETRY_INVALID;if(getstr(b+25,n-25,sid,cap,&z))return ATCH_V3_TRUNCATED;if(25+z!=n)return ATCH_V3_TRUNCATED;v->session_id=sid;return 0; }
typedef struct { uint32_t h[8]; uint64_t bits; unsigned char b[64]; size_t n; } sha256_ctx;
static uint32_t rr(uint32_t x,int n){return (x>>n)|(x<<(32-n));}
static void sha256_block(sha256_ctx *c,const unsigned char *p){static const uint32_t k[64]={0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};uint32_t w[64],a,b,c2,d,e,f,g,h,t1,t2;int i;for(i=0;i<16;i++)w[i]=((uint32_t)p[4*i]<<24)|((uint32_t)p[4*i+1]<<16)|((uint32_t)p[4*i+2]<<8)|p[4*i+3];for(;i<64;i++){uint32_t s0=rr(w[i-15],7)^rr(w[i-15],18)^(w[i-15]>>3),s1=rr(w[i-2],17)^rr(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}a=c->h[0];b=c->h[1];c2=c->h[2];d=c->h[3];e=c->h[4];f=c->h[5];g=c->h[6];h=c->h[7];for(i=0;i<64;i++){uint32_t S1=rr(e,6)^rr(e,11)^rr(e,25),ch=(e&f)^((~e)&g),S0=rr(a,2)^rr(a,13)^rr(a,22),maj=(a&b)^(a&c2)^(b&c2);t1=h+S1+ch+k[i]+w[i];t2=S0+maj;h=g;g=f;f=e;e=d+t1;d=c2;c2=b;b=a;a=t1+t2;}c->h[0]+=a;c->h[1]+=b;c->h[2]+=c2;c->h[3]+=d;c->h[4]+=e;c->h[5]+=f;c->h[6]+=g;c->h[7]+=h;}
static void sha256_init(sha256_ctx*c){static const uint32_t h[]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(c->h,h,sizeof h);c->bits=0;c->n=0;}
static void sha256_update(sha256_ctx*c,const unsigned char*p,size_t n){c->bits+=n*8;while(n){size_t z=64-c->n;if(z>n)z=n;memcpy(c->b+c->n,p,z);c->n+=z;p+=z;n-=z;if(c->n==64){sha256_block(c,c->b);c->n=0;}}}
static void sha256_final(sha256_ctx*c,unsigned char out[32]){size_t i;c->b[c->n++]=0x80;while(c->n!=56){if(c->n==64){sha256_block(c,c->b);c->n=0;}else c->b[c->n++]=0;}for(i=0;i<8;i++)c->b[56+i]=(unsigned char)(c->bits>>(56-8*i));sha256_block(c,c->b);for(i=0;i<8;i++){out[4*i]=(unsigned char)(c->h[i]>>24);out[4*i+1]=(unsigned char)(c->h[i]>>16);out[4*i+2]=(unsigned char)(c->h[i]>>8);out[4*i+3]=(unsigned char)c->h[i];}}
int atch_v3_validate_checkpoint(uint32_t len,uint8_t kind,const unsigned char checksum[32],const unsigned char *snapshot){static const unsigned char d[]="atch-ckpt-v3\0";unsigned char got[32];sha256_ctx c;if(kind>1||len>ATCH_V3_MAX_CHECKPOINT||(!snapshot&&len))return ATCH_V3_PAYLOAD_TOO_LARGE;sha256_init(&c);sha256_update(&c,d,sizeof(d)-1);sha256_update(&c,&kind,1);sha256_update(&c,snapshot,len);sha256_final(&c,got);return memcmp(got,checksum,32)?ATCH_V3_KEY_CONFLICT:0;}
int atch_v3_decode_checkpoint_data(const unsigned char*b,size_t n,atch_v3_checkpoint_data*d){if(n<10)return ATCH_V3_TRUNCATED;d->checkpoint_set_id=u64(b);d->present=b[8];d->snapshot_kind=b[9];if(d->present>1||d->snapshot_kind>1)return ATCH_V3_KEY_CONFLICT;d->put=b+10;d->put_length=n-10;return d->present?0:(d->put_length?ATCH_V3_TRUNCATED:0);}
int atch_v3_decode_journal_data(const unsigned char*b,size_t n,atch_v3_journal_data*d){if(n<4)return ATCH_V3_TRUNCATED;d->record_count=u32(b);d->records=b+4;d->records_length=n-4;return d->record_count?0:ATCH_V3_TRUNCATED;}
int atch_v3_validate_terminal_reply(const atch_v3_terminal_reply *v) { if(!v->query_id||v->source>1||v->query_class<1||v->query_class>9||v->reply_length>ATCH_V3_MAX_TERMINAL_REPLY||(!v->reply&&v->reply_length))return ATCH_V3_KEY_CONFLICT; return 0; }
int atch_v3_validate_generation(uint32_t expected,uint32_t actual) { return expected==actual ? 0 : ATCH_V3_GENERATION_MISMATCH; }
int atch_v3_authorize(uint16_t t,uint8_t role,int owner) { if(role==0 && (t==18||t==19||t==21||t==32||t==34||t==50||t==52||t==64||t==70||t==83))return ATCH_V3_UNKNOWN_TYPE; if(!owner&&(t==18||t==19||t==21||t==34||t==50||t==52||t==64||t==70||t==83))return ATCH_V3_LEASE_DENIED; return 0; }

void atch_v3_reassembler_init(atch_v3_reassembler *r) { memset(r, 0, sizeof *r); }
void atch_v3_reassembler_free(atch_v3_reassembler *r) { free(r->payload); memset(r, 0, sizeof *r); }
int atch_v3_reassembler_push_at(atch_v3_reassembler *r, const unsigned char *b, size_t n, uint64_t now, atch_v3_frame *out) {
    atch_v3_frame f; int rc = atch_v3_decode_frame(b,n,&f); unsigned char *p;
    if (rc) return rc;
    if (r->active && now >= r->expiry_ms) { r->active=0; r->length=0; return ATCH_V3_TRUNCATED; }
    if (!r->active && !(f.flags & 4u)) { if (atch_v3_validate_payload(f.type, f.payload, f.payload_length) != ATCH_V3_OK) return ATCH_V3_TRUNCATED; *out=f; return ATCH_V3_OK; }
    if (!r->active) { r->active=1; r->type=f.type; r->flags=f.flags; r->generation=f.generation; r->sequence=f.sequence; r->aux=f.aux; r->next_sequence=f.sequence; r->expiry_ms=now+ATCH_V3_MORE_TIMEOUT_MS; }
    if (f.type != r->type) { r->active=0; r->length=0; return ATCH_V3_TRUNCATED; }
    if (f.sequence != r->next_sequence) { r->active=0; r->length=0; return ATCH_V3_BAD_SEQUENCE; }
    if (f.payload_length > ATCH_V3_MAX_MSG-r->length) return ATCH_V3_PAYLOAD_TOO_LARGE;
    p=realloc(r->payload,r->length+f.payload_length); if (!p && f.payload_length) { r->active=0; r->length=0; return ATCH_V3_PAYLOAD_TOO_LARGE; }
    r->payload=p; memcpy(r->payload+r->length,f.payload,f.payload_length); r->length+=f.payload_length; r->next_sequence++;
    if (f.flags & 4u) return ATCH_V3_TRUNCATED;
    out->type=r->type; out->flags=r->flags & ~4u; out->generation=r->generation; out->sequence=r->sequence; out->aux=r->aux; out->payload_length=(uint32_t)r->length; out->payload=r->payload;
    if (atch_v3_validate_payload(out->type, out->payload, out->payload_length) != ATCH_V3_OK) {
        r->active=0; r->length=0; return ATCH_V3_TRUNCATED;
    }
    r->active=0; return ATCH_V3_OK;
}
int atch_v3_reassembler_push(atch_v3_reassembler *r,const unsigned char *b,size_t n,atch_v3_frame *out){return atch_v3_reassembler_push_at(r,b,n,0,out);}
int atch_v3_reassembler_expired(const atch_v3_reassembler *r,uint64_t now){return r->active && now>=r->expiry_ms;}
