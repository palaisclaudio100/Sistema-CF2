import crypto from 'node:crypto';
import {PostgresStore} from '../src/postgres-store.mjs';
import {ACTORS,sha} from '../src/actor-transport.mjs';
const encoded=process.argv[2];if(!encoded)throw new Error('PUBLIC_KEY_REQUIRED');const publicKey=crypto.createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'});if(publicKey.asymmetricKeyType!=='rsa')throw new Error('RSA_PUBLIC_KEY_REQUIRED');
const url=process.env.CF2_DATABASE_URL??process.env.DATABASE_URL;
const store=new PostgresStore({connectionString:url,ssl:{rejectUnauthorized:!/^dpg-[a-z0-9]+-a$/.test(new URL(url).hostname)}});
const rows=[];const client=await store.pool.connect();await client.query('BEGIN');
try{
 for(const actor_id of ACTORS){const token=crypto.randomBytes(32).toString('hex');const purpose=actor_id==='ACTOR:DIEGO'?'canary':'worker';const expires_at=new Date(Date.now()+(purpose==='canary'?7200000:7776000000)).toISOString();await client.query('INSERT INTO actor_transport_keys(key_hash,actor_id,capabilities,expires_at) VALUES($1,$2,$3::jsonb,$4)',[sha(token),actor_id,JSON.stringify([purpose]),expires_at]);rows.push({purpose,actor_id,ciphertext:crypto.publicEncrypt({key:publicKey,oaepHash:'sha256'},Buffer.from(JSON.stringify({token,expires_at}))).toString('base64')});}
 const token=crypto.randomBytes(32).toString('hex'),expires_at=new Date(Date.now()+7776000000).toISOString();await client.query('INSERT INTO actor_transport_keys(key_hash,actor_id,capabilities,expires_at) VALUES($1,$2,$3::jsonb,$4)',[sha(token),'ACTOR:CODEX',JSON.stringify(['canon_bridge']),expires_at]);rows.push({purpose:'canon_bridge',actor_id:'ACTOR:CODEX',ciphertext:crypto.publicEncrypt({key:publicKey,oaepHash:'sha256'},Buffer.from(JSON.stringify({token,expires_at}))).toString('base64')});
 await client.query('COMMIT');console.log('RUNTIME_CAPSULE='+JSON.stringify({credentials:rows,public_key_sha256:sha(Buffer.from(encoded,'base64'))}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await store.close();}
