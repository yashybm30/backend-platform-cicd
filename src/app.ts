import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { IsIn, IsInt, Max, Min } from "class-validator";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { Database } from "./database";
import { AuthGuard, AuthRequest } from "./security";
class Upload {
  @IsIn(["image/jpeg", "image/png", "image/webp"]) contentType!: string;
  @IsInt() @Min(1) @Max(10485760) bytes!: number;
}
@Injectable()
export class Storage {
  readonly client = new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
  readonly signer = new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint:
      process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
  constructor() {
    if (!process.env.S3_BUCKET || !process.env.CDN_ORIGIN)
      throw new Error("S3_BUCKET and CDN_ORIGIN required");
    const origin = new URL(process.env.CDN_ORIGIN);
    if (
      origin.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(origin.hostname)
    )
      throw new Error("CDN must use HTTPS");
  }
  async sign(key: string, type: string, bytes: number) {
    return getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        ContentType: type,
        ContentLength: bytes,
        Metadata: { "declared-bytes": String(bytes) },
      }),
      { expiresIn: 300 },
    );
  }
  url(key: string) {
    return `${process.env.CDN_ORIGIN!.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
}
@Controller("v1/media")
@UseGuards(AuthGuard)
class Media {
  constructor(
    private readonly db: Database,
    private readonly storage: Storage,
  ) {}
  @Post("uploads") async upload(
    @Body() input: Upload,
    @Req() req: AuthRequest,
  ) {
    const id = randomUUID(),
      key = `${req.actor.tenantId}/${req.actor.sub}/${id}`;
    const uploadUrl = await this.storage.sign(
      key,
      input.contentType,
      input.bytes,
    );
    await this.db.query(
      "INSERT INTO media(id,tenant_id,user_id,object_key,content_type,expected_bytes) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        req.actor.tenantId,
        req.actor.sub,
        key,
        input.contentType,
        input.bytes,
      ],
    );
    return {
      id,
      uploadUrl,
      expiresIn: 300,
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.bytes),
      },
    };
  }
  @Post(":id/complete") async complete(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    const r = await this.db.query(
      "SELECT * FROM media WHERE id=$1 AND tenant_id=$2 AND user_id=$3",
      [id, req.actor.tenantId, req.actor.sub],
    );
    const media = r.rows[0];
    if (!media) throw new NotFoundException();
    let object;
    try {
      object = await this.storage.client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: media.object_key,
        }),
      );
    } catch {
      throw new BadRequestException("Upload not found");
    }
    if (
      object.ContentLength !== media.expected_bytes ||
      object.ContentType !== media.content_type
    )
      throw new BadRequestException("Uploaded object metadata does not match");
    await this.db.transaction(async (tx) => {
      const changed = await tx.query(
        "UPDATE media SET status=$2 WHERE id=$1 AND status=$3 RETURNING id",
        [id, "ready", "pending"],
      );
      if (changed.rowCount)
        await tx.query(
          "INSERT INTO notifications(id,tenant_id,user_id,media_id,message) VALUES($1,$2,$3,$4,$5)",
          [
            randomUUID(),
            req.actor.tenantId,
            req.actor.sub,
            id,
            "Media upload is ready",
          ],
        );
    });
    return { id, url: this.storage.url(media.object_key), status: "ready" };
  }
  @Get() async list(@Req() req: AuthRequest) {
    const r = await this.db.query(
      "SELECT id,object_key,content_type,created_at FROM media WHERE tenant_id=$1 AND user_id=$2 AND status=$3 ORDER BY created_at DESC LIMIT 50",
      [req.actor.tenantId, req.actor.sub, "ready"],
    );
    return r.rows.map((m) => ({ ...m, url: this.storage.url(m.object_key) }));
  }
}
@Controller("v1/notifications")
@UseGuards(AuthGuard)
class Inbox {
  constructor(private readonly db: Database) {}
  @Get() async list(@Req() req: AuthRequest) {
    return (
      await this.db.query(
        "SELECT * FROM notifications WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 100",
        [req.actor.tenantId, req.actor.sub],
      )
    ).rows;
  }
  @Patch(":id/read") async read(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    const r = await this.db.query(
      "UPDATE notifications SET read_at=now() WHERE id=$1 AND tenant_id=$2 AND user_id=$3 RETURNING id",
      [id, req.actor.tenantId, req.actor.sub],
    );
    if (!r.rowCount) throw new NotFoundException();
    return { read: true };
  }
}
@Controller("health")
class Health {
  constructor(private readonly db: Database) {}
  @Get("live") live() {
    return { status: "alive" };
  }
  @Get("ready") async ready() {
    await this.db.query("SELECT 1 FROM media LIMIT 1");
    return { status: "ready" };
  }
}
@Module({
  controllers: [Media, Inbox, Health],
  providers: [Database, Storage, AuthGuard],
})
export class AppModule {}
