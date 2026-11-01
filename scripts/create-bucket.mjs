import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
import {setTimeout as delay} from 'node:timers/promises';
const client=new S3Client({region:process.env.AWS_REGION||'us-east-1',endpoint:process.env.S3_ENDPOINT,forcePathStyle:true,maxAttempts:1});
try{for(let attempt=1;;attempt++){try{await client.send(new CreateBucketCommand({Bucket:process.env.S3_BUCKET||'media'}));break;}catch(error){if(['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes(error.name))break;if(attempt>=15)throw error;await delay(1000);}}}finally{client.destroy();}
