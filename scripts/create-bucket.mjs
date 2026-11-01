import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3';
const client=new S3Client({region:process.env.AWS_REGION||'us-east-1',endpoint:process.env.S3_ENDPOINT,forcePathStyle:true});try{await client.send(new CreateBucketCommand({Bucket:process.env.S3_BUCKET||'media'}));}catch(e){if(!['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes(e.name))throw e;}finally{client.destroy();}
