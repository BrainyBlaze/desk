#include "atch_wire_v3.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char hex(char c) { return (unsigned char)(c <= '9' ? c-'0' : (c|32)-'a'+10); }
static size_t read_hex(const char *p, unsigned char **out) {
    size_t n=0, i=0; unsigned char *b;
    while (p[i] && p[i] != '"') { if (p[i] != '\n' && p[i] != '\r' && p[i] != ' ') ++n; ++i; }
    assert((n & 1) == 0); b=malloc(n/2); i=0; n=0;
    while (p[i] && p[i] != '"') { if (p[i] != '\n' && p[i] != '\r' && p[i] != ' ') { b[n/2] = (n&1) ? b[n/2]*16+hex(p[i]) : hex(p[i]); ++n; } ++i; }
    *out=b; return n/2;
}
static void vectors(void) {
    FILE *fp=fopen("tests/fixtures/atch-wire/vectors.json","rb"); long sz; char *s,*p; size_t count=0;
    assert(fp); fseek(fp,0,SEEK_END); sz=ftell(fp); rewind(fp); s=malloc((size_t)sz+1); assert(fread(s,1,(size_t)sz,fp)==(size_t)sz); fclose(fp); s[sz]=0;
    for (p=s; (p=strstr(p,"\"frameHex\": \"")); p+=10) { unsigned char *b,*h; size_t n=read_hex(p+13,&b), hn; atch_v3_frame f;
        assert(atch_v3_decode_frame(b,n,&f)==ATCH_V3_OK); assert(atch_v3_decode_frame_ex(b,n,&f,1)==ATCH_V3_OK); h=malloc(ATCH_V3_HEADER_LEN); hn=atch_v3_encode_header(h,ATCH_V3_HEADER_LEN,f.type,f.flags,f.generation,f.sequence,f.aux,f.payload_length); assert(hn==ATCH_V3_HEADER_LEN); assert(!memcmp(h,b,hn)); free(h); free(b); ++count;
    }
    /* Exercise every frameHex entry in the pinned 32-vector corpus. */
    assert(count == 32);
    p=strstr(s,"\"bad_magic\""); assert(p); { unsigned char *b; assert(read_hex(strstr(p,"\"hex\": \"")+8,&b)==36); assert(atch_v3_decode_frame(b,36,&(atch_v3_frame){0})==ATCH_V3_BAD_MAGIC); free(b); }
    p=strstr(s,"\"bad_version\""); assert(p); { unsigned char *b; assert(read_hex(strstr(p,"\"hex\": \"")+8,&b)==36); assert(atch_v3_decode_frame(b,36,&(atch_v3_frame){0})==ATCH_V3_BAD_VERSION); free(b); }
    free(s);
}
static void payload_schema_negatives(void) {
    unsigned char b[128]; size_t n;
    n=atch_v3_encode_header(b,sizeof b,17,0,0,0,0,15); assert(atch_v3_decode_frame_ex(b,n+15,&(atch_v3_frame){0},1)==ATCH_V3_TRUNCATED);
    n=atch_v3_encode_header(b,sizeof b,67,0,0,0,0,4); memset(b+n,0,4); assert(atch_v3_decode_frame_ex(b,n+4,&(atch_v3_frame){0},1)==ATCH_V3_TRUNCATED);
    n=atch_v3_encode_header(b,sizeof b,69,0,0,0,0,10); memset(b+n,0,10); b[n+8]=1; b[n+9]=1; assert(atch_v3_decode_frame_ex(b,n+10,&(atch_v3_frame){0},1)==0);
    n=atch_v3_encode_header(b,sizeof b,18,0,1,1,0,10);
    memset(b+n,0,10); b[n+5]=1; b[n+9]='\r';
    assert(atch_v3_decode_frame_ex(b,n+10,&(atch_v3_frame){0},1)==0);
}
static void bounds_and_u64(void) {
    unsigned char b[64], expected[] = { 'A','T','V','3',3,0,6,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 }, payload[1]={0}; atch_v3_frame f; atch_v3_reassembler r; size_t n;
    assert(atch_v3_encode_header(b,sizeof b,6,0,0,UINT64_MAX,UINT64_MAX,1)==36); memcpy(b+36,payload,1); assert(atch_v3_decode_frame(b,37,&f)==0); assert(f.sequence==UINT64_MAX && f.aux==UINT64_MAX);
    assert(!memcmp(b, expected, 8));
    b[12]=1; b[13]=0; b[14]=16; b[15]=0; assert(atch_v3_decode_frame(b,37,&f)==ATCH_V3_PAYLOAD_TOO_LARGE);
    b[12]=0; b[13]=0; b[14]=0; b[15]=0; b[0]='X'; assert(atch_v3_decode_frame(b,36,&f)==ATCH_V3_BAD_MAGIC); b[0]='A';
    b[4]=4; assert(atch_v3_decode_frame(b,36,&f)==ATCH_V3_BAD_VERSION); b[4]=3;
    assert(atch_v3_decode_frame(b,35,&f)==ATCH_V3_TRUNCATED);
    b[6]=7; assert(atch_v3_decode_frame_ex(b,36,&f,1)==ATCH_V3_UNKNOWN_TYPE);
    b[6]=6; b[8]=0x10; assert(atch_v3_decode_frame(b,36,&f)==ATCH_V3_OK); assert(atch_v3_decode_frame_ex(b,36,&f,1)==ATCH_V3_BAD_FLAGS);
    b[8]=0x20; assert(atch_v3_decode_frame_ex(b,36,&f,1)==ATCH_V3_BAD_FLAGS);
    atch_v3_reassembler_init(&r); n=atch_v3_encode_header(b,64,48,4,0,9,0,12); memset(b+n,1,12); assert(atch_v3_reassembler_push(&r,b,n+12,&f)==ATCH_V3_TRUNCATED);
    n=atch_v3_encode_header(b,64,48,0,0,10,0,13); memset(b+n,2,13); assert(atch_v3_reassembler_push(&r,b,n+13,&f)==ATCH_V3_OK); assert(f.payload_length==25 && f.payload[0]==1 && f.payload[24]==2); atch_v3_reassembler_free(&r);
    atch_v3_reassembler_init(&r); n=atch_v3_encode_header(b,64,48,4,0,9,0,25); memset(b+n,1,25); assert(atch_v3_reassembler_push(&r,b,n+25,&f)==ATCH_V3_TRUNCATED); n=atch_v3_encode_header(b,64,17,0,0,10,0,16); memset(b+n,2,16); assert(atch_v3_reassembler_push(&r,b,n+16,&f)==ATCH_V3_TRUNCATED); assert(!r.active); n=atch_v3_encode_header(b,64,17,0,0,10,0,16); memset(b+n,2,16); assert(atch_v3_reassembler_push(&r,b,n+16,&f)==ATCH_V3_OK); atch_v3_reassembler_free(&r);
    atch_v3_reassembler_init(&r); n=atch_v3_encode_header(b,64,48,4,0,9,0,25); memset(b+n,1,25); assert(atch_v3_reassembler_push(&r,b,n+25,&f)==ATCH_V3_TRUNCATED); n=atch_v3_encode_header(b,64,48,0,0,11,0,25); memset(b+n,2,25); assert(atch_v3_reassembler_push(&r,b,n+25,&f)==ATCH_V3_BAD_SEQUENCE); assert(!r.active); n=atch_v3_encode_header(b,64,48,0,0,11,0,25); memset(b+n,2,25); assert(atch_v3_reassembler_push(&r,b,n+25,&f)==ATCH_V3_OK); atch_v3_reassembler_free(&r);
}
static void record_crc(void) {
    unsigned char b[30]={1}; atch_v3_record r; uint32_t crc;
    b[21]=1; b[25]=0x5a; crc=atch_v3_crc32(b,26); b[26]=(unsigned char)crc; b[27]=(unsigned char)(crc>>8); b[28]=(unsigned char)(crc>>16); b[29]=(unsigned char)(crc>>24);
    assert(atch_v3_decode_record(b,sizeof b,&r)==ATCH_V3_OK); assert(r.record_type==1 && r.body_length==1 && r.body[0]==0x5a); b[25]^=1; assert(atch_v3_decode_record(b,sizeof b,&r)==ATCH_V3_TRUNCATED);
}
static void typed(void) {
    unsigned char b[1024], id[16]={0xa1}; size_t n; char sid[64]; atch_v3_hello h={3,1,0x2f,{0}}; atch_v3_attach a={1,6,1234,56,40,120,"agentdesk-x"}; atch_v3_hello hd; atch_v3_attach ad; atch_v3_terminal_reply tr={0,4,7,2,77,NULL,0};
    memcpy(h.incarnation,id,16); assert(atch_v3_encode_hello(&h,b,sizeof b,&n)==0&&n==23); assert(atch_v3_decode_hello(b,n,&hd)==0&&hd.capabilities==0x2f&&!memcmp(hd.incarnation,id,16)); h.capabilities=0x40; assert(atch_v3_encode_hello(&h,b,sizeof b,&n)==ATCH_V3_CAP_UNSUPPORTED); h.capabilities=0x2f;
    assert(atch_v3_encode_attach(&a,b,sizeof b,&n)==0); assert(atch_v3_decode_attach(b,n,&ad,sid,sizeof sid)==0&&ad.rows==40&&!strcmp(sid,"agentdesk-x")); a.rows=0; assert(atch_v3_encode_attach(&a,b,sizeof b,&n)==ATCH_V3_GEOMETRY_INVALID); a.rows=40;
    {
        static const unsigned char snapshot[]="abc";
        static const unsigned char digest[32]={0x09,0x7a,0x9f,0xa2,0x35,0x32,0x0c,0x75,0x33,0xc5,0xe8,0xcf,0x9d,0x8e,0xa1,0x48,0x2d,0x5e,0xa4,0xa3,0xd8,0x7b,0xc6,0x5d,0xdd,0xa5,0xc4,0xd5,0xce,0x31,0x40,0xa4};
        unsigned char mismatch[32]; atch_v3_checkpoint_data cd; atch_v3_journal_data jd;
        assert(atch_v3_validate_checkpoint(3,1,digest,snapshot)==0); memcpy(mismatch,digest,sizeof mismatch); mismatch[0]^=1;
        assert(atch_v3_validate_checkpoint(3,1,mismatch,snapshot)==ATCH_V3_KEY_CONFLICT); assert(atch_v3_validate_checkpoint(ATCH_V3_MAX_CHECKPOINT+1,1,digest,snapshot)==ATCH_V3_PAYLOAD_TOO_LARGE);
        memset(b,0,10); b[0]=7; b[8]=1; b[9]=1; memcpy(b+10,"payload",7);
        assert(atch_v3_decode_checkpoint_data(b,17,&cd)==0); assert(cd.checkpoint_set_id==7 && cd.present==1 && cd.snapshot_kind==1 && cd.put_length==7); b[8]=0;
        assert(atch_v3_decode_checkpoint_data(b,10,&cd)==0); assert(atch_v3_decode_checkpoint_data(b,11,&cd)==ATCH_V3_TRUNCATED);
        b[0]=2; b[1]=0; b[2]=0; b[3]=0; memset(b+4,0xa5,8); assert(atch_v3_decode_journal_data(b,12,&jd)==0 && jd.record_count==2 && jd.records_length==8); b[0]=0;
        assert(atch_v3_decode_journal_data(b,12,&jd)==ATCH_V3_TRUNCATED);
    }
    tr.reply=(const unsigned char *)"x";tr.reply_length=1;assert(atch_v3_validate_terminal_reply(&tr)==0);tr.reply_length=ATCH_V3_MAX_TERMINAL_REPLY+1;assert(atch_v3_validate_terminal_reply(&tr)==ATCH_V3_KEY_CONFLICT);assert(atch_v3_validate_generation(2,3)==ATCH_V3_GENERATION_MISMATCH);assert(atch_v3_authorize(18,0,0)==ATCH_V3_UNKNOWN_TYPE);assert(atch_v3_authorize(18,1,0)==ATCH_V3_LEASE_DENIED);
}
static void timeout(void) {
    unsigned char b[64]; size_t n; atch_v3_frame f; atch_v3_reassembler r;
    atch_v3_reassembler_init(&r); n=atch_v3_encode_header(b,sizeof b,16,4,0,1,0,1); b[n]=1; assert(atch_v3_reassembler_push_at(&r,b,n+1,100,&f)==ATCH_V3_TRUNCATED); assert(atch_v3_reassembler_expired(&r,5100)); n=atch_v3_encode_header(b,sizeof b,16,0,0,2,0,1); b[n]=2; assert(atch_v3_reassembler_push_at(&r,b,n+1,5100,&f)==ATCH_V3_TRUNCATED); atch_v3_reassembler_free(&r);
}

/*
** TERMINAL_STATE (84): connection-local blob32 carrying the child's live ANSI
** mode preamble, so a controller re-attaching with a fresh emulator learns the
** modes the child set once at startup. The golden vector only exercises the
** cases it contains, so the boundaries are pinned here explicitly.
*/
static void terminal_state(void) {
    unsigned char b[64]; atch_v3_frame f; size_t n;

    /* Accepted as a known type (STRICT decode would reject an unknown one). */
    n = atch_v3_encode_header(b, sizeof b, 84, 0, 0, 1, 0, 5);
    b[n] = 1; b[n+1] = 0; b[n+2] = 0; b[n+3] = 0; b[n+4] = 0x1b;
    assert(atch_v3_decode_frame(b, n + 5, &f) == 0 && f.type == 84);

    /* Declared blob length must match the body EXACTLY: short, long, and the
     * missing-prefix case are all truncations, never silently accepted. */
    b[n] = 1; assert(atch_v3_validate_payload(84, b + n, 5) == 0);
    b[n] = 2; assert(atch_v3_validate_payload(84, b + n, 5) == ATCH_V3_TRUNCATED);
    b[n] = 0; assert(atch_v3_validate_payload(84, b + n, 5) == ATCH_V3_TRUNCATED);
    assert(atch_v3_validate_payload(84, b + n, 3) == ATCH_V3_TRUNCATED);

    /* An empty preamble is legitimate: the child may have set no modes yet. */
    b[n] = b[n+1] = b[n+2] = b[n+3] = 0;
    assert(atch_v3_validate_payload(84, b + n, 4) == 0);
}
int main(void) { vectors(); payload_schema_negatives(); bounds_and_u64(); record_crc(); typed(); timeout(); terminal_state(); puts("wire-v3 conformance: ok"); return 0; }
