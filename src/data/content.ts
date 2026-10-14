import { parseHex, type RGB } from '../core/math';

export interface ProjectMeta {
  label: string;
  value: string;
}

export interface Project {
  id: string;
  index: string;
  name: string;
  discipline: string;
  summary: string;
  body: string;
  meta: ProjectMeta[];
  /** Signature colour — drives the whole scene while this project is on stage. */
  accent: RGB;
  accentHex: string;
}

export const projects: Project[] = [
  {
    id: 'aegislogix',
    index: '01',
    name: 'AegisLogix',
    discipline: 'Industrial computer vision',
    summary:
      'A container-damage inspection system. Fine-tuning and dataset work took the model from 0.217 to 0.561 mAP50 overall.',
    body:
      'FastAPI backend and a React frontend for upload validation, preprocessing and interactive damage visualization. The model is served through an ONNX Runtime pipeline, containerized with Docker and deployed on Render. Correcting bad annotations and rebalancing classes took the Dent class to 0.83 mAP50.',
    meta: [
      { label: 'Role', value: 'Full-stack + model training' },
      { label: 'Stack', value: 'Python · FastAPI · React · ONNX' },
      { label: 'Outcome', value: 'mAP50 0.217 → 0.561' },
    ],
    accentHex: '#5fe3cf',
    accent: parseHex('#5fe3cf'),
  },
  {
    id: 'attendly',
    index: '02',
    name: 'Attendly',
    discipline: 'Offline-first attendance PWA',
    summary:
      'An offline-first attendance PWA, used by twenty students across three semesters without needing a network.',
    body:
      'Next.js and TypeScript, with localStorage as the primary store and Firebase as optional sync. Credit-hour-weighted attendance drives the analytics, bunk-risk indicators and recovery timelines, with the business logic kept out of the UI. A cloud AI timetable import was replaced with client-side Tesseract.js OCR and deterministic parsing.',
    meta: [
      { label: 'Used by', value: '20 students' },
      { label: 'For', value: '3 semesters' },
      { label: 'Tests', value: 'Vitest' },
    ],
    accentHex: '#ff8b4c',
    accent: parseHex('#ff8b4c'),
  },
  {
    id: 'gitrunbykaru',
    index: '03',
    name: 'GitRunByKaru',
    discipline: 'Open-source developer CLI',
    summary:
      'An open-source npm CLI that clones a repo, detects its stack, installs and launches it. 1,500+ downloads.',
    body:
      'The runtime automates framework detection, verifies that services are actually ready over HTTP, and manages the lifecycle of temporary workspaces. Published to npm and exposed over MCP, so AI coding agents can invoke it as a tool.',
    meta: [
      { label: 'Downloads', value: '1,500+' },
      { label: 'Interface', value: 'MCP' },
      { label: 'Runtime', value: 'Node.js' },
    ],
    accentHex: '#a892ff',
    accent: parseHex('#a892ff'),
  },
];

export interface Capability {
  index: string;
  title: string;
  body: string;
  tags: string[];
}

export const capabilities: Capability[] = [
  {
    index: '01',
    title: 'Frontend engineering',
    body:
      'React and Next.js apps built for real users rather than demos — offline-first storage, client-side OCR, and state that survives a bad network.',
    tags: ['React', 'Next.js', 'TypeScript', 'Tailwind CSS'],
  },
  {
    index: '02',
    title: 'Backend & APIs',
    body:
      'Python and FastAPI services with REST endpoints, from image-upload validation to inference pipelines served through ONNX Runtime.',
    tags: ['FastAPI', 'Node.js', 'REST', 'MySQL'],
  },
  {
    index: '03',
    title: 'Computer vision & ML',
    body:
      'Detection models fine-tuned with Ultralytics, exported to ONNX for inference, and evaluated on metrics I actually tracked.',
    tags: ['OpenCV', 'YOLOv5/v8', 'ONNX', 'Ultralytics'],
  },
  {
    index: '04',
    title: 'Developer tooling',
    body:
      'CLI runtimes, Docker and deployment pipelines — plus an MCP server so coding agents can drive the tooling directly.',
    tags: ['Git', 'Docker', 'npm', 'MCP'],
  },
];

/**
 * Exported for the test suite rather than for rendering: the visible chrome
 * copy lives in `index.html` so it stays where it is read and styled.
 */
export const site = {
  name: 'KARTHIKEYA DUSI',
  role: 'Software engineer',
  email: 'karthikeyadusi@gmail.com',
  location: 'Visakhapatnam, India',
  links: [
    { label: 'GitHub', href: 'https://github.com/Karthikeyadusi' },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/karthikeyadusi/' },
    { label: 'npm', href: 'https://www.npmjs.com/package/gitrunbykaru' },
  ],
} as const;

export const navSections = [
  { id: 'intro', index: '01', label: 'Intro' },
  { id: 'work', index: '02', label: 'Work' },
  { id: 'about', index: '03', label: 'About' },
  { id: 'contact', index: '04', label: 'Contact' },
] as const;
