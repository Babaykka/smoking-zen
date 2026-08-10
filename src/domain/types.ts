export type Priority = 1 | 2 | 3 | 4 | 5;

export type RecordMetadata = {
  id: string;
  workspaceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type TaskStatus = RecordMetadata & {
  name: string;
  position: number;
  isCompleted: boolean;
};

export type Section = RecordMetadata & {
  name: string;
  position: number;
};

export type Task = RecordMetadata & {
  title: string;
  description: string;
  priority: Priority;
  statusId: string;
  sectionId: string | null;
  assigneeId: string | null;
  dueAt: string | null;
  attachments: Attachment[];
};

export type Comment = RecordMetadata & {
  taskId: string;
  authorId: string;
  body: string;
};

export type KnowledgeKind = 'note' | 'instruction' | 'document' | 'link';

export type KnowledgeItem = RecordMetadata & {
  title: string;
  body: string;
  kind: KnowledgeKind;
  linkUrl: string | null;
  sectionId: string | null;
  attachments: Attachment[];
};

export type ContactMethodKind = 'phone' | 'telegram' | 'whatsapp';

export type ContactMethod = {
  kind: ContactMethodKind;
  value: string;
};

export type ContactCategory = 'supplier' | 'service' | 'landlord' | 'cleaning' | 'other';

export type Contact = RecordMetadata & {
  name: string;
  category: ContactCategory;
  notes: string;
  methods: ContactMethod[];
};

export type WorkspaceMemberRole = 'owner' | 'member';

export type WorkspaceMember = RecordMetadata & {
  name: string;
  role: WorkspaceMemberRole;
  active: boolean;
};

export type SecureItemSummary = RecordMetadata & {
  title: string;
  purpose: string;
  owner: string;
  reviewDate: string | null;
  cardBank: string | null;
  cardHolder: string | null;
  cardPurpose: string | null;
  lastFour: string | null;
};

export type SecureItemReveal = { externalUrl: string };

export type AuditAction = 'created' | 'updated' | 'deleted' | 'restored';

export type AuditEvent = {
  id: string;
  workspaceId: string;
  entity: WorkspaceEntity;
  entityId: string;
  action: AuditAction;
  occurredAt: string;
};

export type NotificationDelivery = RecordMetadata & {
  eventId: string;
  channel: 'telegram';
  deliveredAt: string | null;
};

export type WorkspaceEntity = 'task' | 'comment' | 'knowledge' | 'contact' | 'secureItem';

export type WorkspaceSnapshot = {
  workspaceId: string;
  taskStatuses: TaskStatus[];
  sections: Section[];
  tasks: Task[];
  comments: Comment[];
  knowledge: KnowledgeItem[];
  contacts: Contact[];
  members: WorkspaceMember[];
  secureItems: SecureItemSummary[];
  auditEvents: AuditEvent[];
  notificationDeliveries: NotificationDelivery[];
};

export type SearchResult = {
  entity: 'task' | 'knowledge' | 'contact';
  id: string;
  title: string;
};

export type SearchNavigationTarget = {
  id: string;
  requestKey: number;
};
