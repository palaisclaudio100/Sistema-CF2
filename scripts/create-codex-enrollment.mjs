import {PostgresStore} from '../src/postgres-store.mjs';
import {RoleEnrollmentService,ENROLLMENT_TTL_SECONDS} from '../src/role-enrollment.mjs';

const database_url=process.env.CF2_DATABASE_URL??process.env.DATABASE_URL;
const baseUrl=process.env.RENDER_EXTERNAL_URL??'https://cf2-prod-core.onrender.com';
if(!database_url||!process.env.CF2_GOOGLE_OAUTH_CLIENT_SECRET)throw new Error('ENROLLMENT_CONFIGURATION_REQUIRED');
const databaseHost=new URL(database_url).hostname,renderInternal=/^dpg-[a-z0-9]+-a$/.test(databaseHost);
const store=new PostgresStore({connectionString:database_url,ssl:{rejectUnauthorized:!renderInternal}});
try{
  await store.migrate();
  const service=new RoleEnrollmentService(store,{baseUrl,signingSecret:process.env.CF2_GOOGLE_OAUTH_CLIENT_SECRET});
  const enrollment=await service.createCodexEnrollment();
  process.stdout.write(`${JSON.stringify({ttl_seconds:ENROLLMENT_TTL_SECONDS,enrollment_id:enrollment.enrollment_id,actor_id:enrollment.actor_id,url:enrollment.url})}\n`);
}finally{await store.close();}
