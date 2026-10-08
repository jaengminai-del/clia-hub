"""
CCG Component Parser for LG.com PDP Crawler

LG.com HTML에서 CCG 컴포넌트 ID와 내부 요소를 추출하여
eBay 빌더가 동일한 레이아웃을 재현할 수 있도록 구조화된 데이터를 생성합니다.

컴포넌트 접두사:
- ST: Static Components (히어로, 텍스트, 갤러리 등)
- PD: Product Components (제품 목록, 요약, 스펙 등)
- CM: Common Components (GNB, Footer 등)
- PR: Promotion Components
- PN: Personalization Components
- GN: Global Newsroom Components
- AL: About LG Components
"""

import re
from bs4 import BeautifulSoup, Tag
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field, asdict
from enum import Enum


class LayoutType(str, Enum):
    """컴포넌트 레이아웃 타입"""
    HERO_FULL_WIDTH = "hero_full_width"           # ST0001: 전체 너비 히어로
    IMAGE_TEXT_LEFT = "image_text_left"           # 이미지 좌측, 텍스트 우측
    IMAGE_TEXT_RIGHT = "image_text_right"         # 이미지 우측, 텍스트 좌측
    TEXT_OVER_IMAGE = "text_over_image"           # 이미지 배경 위 텍스트
    GRID_2_COLUMN = "grid_2_column"               # 2컬럼 그리드
    GRID_3_COLUMN = "grid_3_column"               # 3컬럼 그리드
    GRID_4_COLUMN = "grid_4_column"               # 4컬럼 그리드
    CAROUSEL = "carousel"                          # 캐러셀/슬라이더
    TAB_CONTENT = "tab_content"                    # 탭 컨텐츠
    ACCORDION = "accordion"                        # 아코디언/접기펼치기
    ICON_GRID = "icon_grid"                        # 아이콘 그리드
    PRODUCT_GALLERY = "product_gallery"            # 제품 갤러리
    SPEC_TABLE = "spec_table"                      # 스펙 테이블
    VERTICAL_STACK = "vertical_stack"              # 수직 스택
    UNKNOWN = "unknown"


class TextAlignment(str, Enum):
    """텍스트 정렬"""
    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"


@dataclass
class TextElement:
    """텍스트 요소"""
    role: str  # eyebrow, headline, subheadline, body_copy, disclaimer
    text: str
    font_size_desktop: Optional[str] = None
    font_size_mobile: Optional[str] = None
    font_weight: Optional[str] = None


@dataclass
class MediaElement:
    """미디어 요소"""
    type: str  # image, video, animation
    src_desktop: Optional[str] = None
    src_mobile: Optional[str] = None
    alt: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    video_id: Optional[str] = None  # YouTube/BrightCove ID


@dataclass
class CTAElement:
    """CTA 버튼 요소"""
    type: str  # primary, secondary, text_link
    text: str
    href: Optional[str] = None


@dataclass
class SpecPair:
    """스펙 항목 — 라벨과 값의 짝 (Summary / Key Specs / 스펙표)

    라벨과 값을 평면 텍스트 목록으로 흘리면 '라벨 4개 + 값 4개'로 갈라져
    어느 값이 어느 항목인지 알 수 없다. DOM의 짝 구조를 그대로 보존한다.
    """
    label: str
    value: str
    group: Optional[str] = None   # 'DIMENSIONS & WEIGHT' 같은 스펙 그룹명


@dataclass
class ItemGroup:
    """항목 단위 그룹 — 캐러셀 슬라이드/카드 하나가 갖는 텍스트 + 이미지 묶음

    LG 컴포넌트는 한 컴포넌트 안에 같은 모양의 항목을 N개 반복한다
    (예: ST0016 아코디언 = cmp-carousel__item 2개, 각각 제목·본문·이미지 보유).
    컴포넌트 전체를 한 덩어리로 평탄화하면 '제목 N개 → 본문 N개 → 이미지 N개'로
    갈라져 어느 이미지가 어느 텍스트의 것인지 알 수 없다. 항목 경계를 보존한다.
    """
    texts: List[TextElement] = field(default_factory=list)
    media: List[MediaElement] = field(default_factory=list)


@dataclass
class ComponentElement:
    """컴포넌트 내부 요소 구조"""
    texts: List[TextElement] = field(default_factory=list)
    media: List[MediaElement] = field(default_factory=list)
    ctas: List[CTAElement] = field(default_factory=list)
    specs: List[SpecPair] = field(default_factory=list)
    items: List[ItemGroup] = field(default_factory=list)   # 항목별 텍스트+이미지 묶음


@dataclass
class ParsedComponent:
    """파싱된 컴포넌트 데이터"""
    component_id: str                          # ST0001, PD0012 등
    component_type: str                        # ST, PD, CM 등
    layout_type: LayoutType                    # 레이아웃 타입
    text_alignment: TextAlignment              # 텍스트 정렬
    background_type: str                       # image, color, gradient
    background_value: Optional[str] = None     # 배경 이미지 URL 또는 색상
    elements: ComponentElement = field(default_factory=ComponentElement)
    raw_html: Optional[str] = None             # 원본 HTML (디버깅용)
    dom_index: int = -1                        # HTML DOM 등장 순번 (0부터). 섹션 정렬의 진실 기준
    column_count: int = 0                      # DOM이 선언한 컬럼 수(column-N 클래스). 0=미선언

    def to_dict(self) -> Dict[str, Any]:
        """딕셔너리 변환"""
        return {
            "component_id": self.component_id,
            "dom_index": self.dom_index,
            "component_type": self.component_type,
            "layout_type": self.layout_type.value,
            "column_count": self.column_count,
            "text_alignment": self.text_alignment.value,
            "background_type": self.background_type,
            "background_value": self.background_value,
            "elements": {
                "texts": [asdict(t) for t in self.elements.texts],
                "media": [asdict(m) for m in self.elements.media],
                "ctas": [asdict(c) for c in self.elements.ctas],
                "specs": [asdict(s) for s in self.elements.specs],
                "items": [{"texts": [asdict(t) for t in it.texts],
                           "media": [asdict(m) for m in it.media]}
                          for it in self.elements.items]
            }
        }


# 컴포넌트 ID -> 레이아웃 타입 매핑
COMPONENT_LAYOUT_MAP: Dict[str, LayoutType] = {
    # ST Components
    "ST0001": LayoutType.HERO_FULL_WIDTH,      # Hero Image
    "ST0002": LayoutType.HERO_FULL_WIDTH,      # Hero Video
    "ST0003": LayoutType.VERTICAL_STACK,       # Title
    "ST0004": LayoutType.TEXT_OVER_IMAGE,      # Block Content
    "ST0005": LayoutType.GRID_2_COLUMN,        # Block Image - 2 column
    "ST0007": LayoutType.GRID_3_COLUMN,        # Block Image - 3 column
    "ST0008": LayoutType.HERO_FULL_WIDTH,      # Large Image
    "ST0009": LayoutType.HERO_FULL_WIDTH,      # Large Image
    "ST0011": LayoutType.IMAGE_TEXT_LEFT,      # Side Image
    "ST0013": LayoutType.IMAGE_TEXT_RIGHT,     # Side Image Reverse
    "ST0014": LayoutType.GRID_4_COLUMN,        # Block Content 4 column
    "ST0016": LayoutType.ACCORDION,            # Folding Content
    "ST0017": LayoutType.VERTICAL_STACK,       # Text Only
    "ST0018": LayoutType.CAROUSEL,             # Carousel
    "ST0027": LayoutType.ICON_GRID,            # Key Benefit Summary
    "ST0031": LayoutType.GRID_2_COLUMN,        # Before/After
    "ST0035": LayoutType.VERTICAL_STACK,       # Spec Comparison
    "ST0036": LayoutType.TAB_CONTENT,          # Feature Icon Tab
    "ST0038": LayoutType.TEXT_OVER_IMAGE,      # Quote
    "ST0044": LayoutType.VERTICAL_STACK,       # Legal Text
    "ST0047": LayoutType.CAROUSEL,             # Card Carousel
    "ST0048": LayoutType.CAROUSEL,             # Horizontal Scroll Carousel
    "ST0049": LayoutType.VERTICAL_STACK,       # FAQ
    "ST0053": LayoutType.TAB_CONTENT,          # Tab Content

    # PD Components
    "PD0001": LayoutType.GRID_4_COLUMN,        # Product List
    "PD0003": LayoutType.VERTICAL_STACK,       # Product Summary
    "PD0008": LayoutType.SPEC_TABLE,           # Spec
    "PD0012": LayoutType.PRODUCT_GALLERY,      # Product Visual
    "PD0033": LayoutType.TAB_CONTENT,          # Functional Tab
    "PD0046": LayoutType.TEXT_OVER_IMAGE,      # Product Content
}


class ComponentParser:
    """CCG 컴포넌트 파서"""

    # 컴포넌트 ID 패턴
    COMPONENT_ID_PATTERN = re.compile(r'\b(ST|PD|CM|PR|PN|GN|AL)\d{4}\b')

    # 폰트 크기 패턴 (예: font-w-light-56, font-m-normal-14)
    FONT_SIZE_PATTERN = re.compile(r'font-(w|m)-(light|normal|semibold|bold)-(\d+)')

    def __init__(self, html: str):
        """
        Args:
            html: 파싱할 HTML 문자열
        """
        self.soup = BeautifulSoup(html, 'html.parser')
        self.components: List[ParsedComponent] = []

    def parse_all(self) -> List[ParsedComponent]:
        """
        HTML에서 모든 CCG 컴포넌트를 파싱합니다.

        Returns:
            파싱된 컴포넌트 리스트
        """
        # c-wrapper 클래스를 가진 모든 요소 찾기
        wrappers = self.soup.find_all(class_=re.compile(r'c-wrapper'))

        # 캐러셀(Swiper) 루프 모드는 무한 회전처럼 보이도록 슬라이드를 복제해 앞뒤에 붙인다.
        # 복제본은 원본과 id·data-swiper-slide-index·이미지·문구가 모두 같으므로
        # (캐러셀, 슬라이드 번호)가 이미 나온 슬라이드는 건너뛰고, 슬라이드는 원래 순서로 정렬한다.
        seen_slides = set()
        carousel_slots = {}   # 캐러셀 → 그 캐러셀 슬라이드들이 차지한 components 위치 목록
        for wrapper in wrappers:
            slide = wrapper.find_parent(attrs={'data-swiper-slide-index': True})
            carousel = slide.find_parent(class_=re.compile(r'\bswiper\b|cmp-carousel')) if slide else None
            if slide is not None:
                key = (id(carousel), slide.get('data-swiper-slide-index'))
                if key in seen_slides:
                    continue
                seen_slides.add(key)
            component = self._parse_component(wrapper)
            if component:
                if slide is not None:
                    carousel_slots.setdefault(id(carousel), []).append(
                        (len(self.components), int(slide.get('data-swiper-slide-index') or 0)))
                self.components.append(component)

        # 같은 캐러셀의 슬라이드는 슬라이드 번호 순서(1→2→3)로 재배치 (루프 모드는 DOM 순서가 회전돼 있음)
        for slots in carousel_slots.values():
            positions = [pos for pos, _ in slots]
            ordered = [self.components[pos] for pos, _ in sorted(slots, key=lambda x: x[1])]
            for pos, comp in zip(positions, ordered):
                self.components[pos] = comp

        for i, component in enumerate(self.components):
            component.dom_index = i  # DOM 등장 순번 부여
        return self.components

    def _parse_component(self, element: Tag) -> Optional[ParsedComponent]:
        """
        단일 컴포넌트를 파싱합니다.
        """
        classes = element.get('class', [])
        if isinstance(classes, str):
            classes = classes.split()

        # 컴포넌트 ID 추출
        component_id = None
        for cls in classes:
            match = self.COMPONENT_ID_PATTERN.match(cls)
            if match:
                component_id = cls
                break

        if not component_id:
            return None

        component_type = component_id[:2]
        layout_type = COMPONENT_LAYOUT_MAP.get(component_id, LayoutType.UNKNOWN)

        # DOM 선언 컬럼 수: 컨테이너 자신 또는 내부 캐러셀/그리드의 column-N 클래스.
        # AEM이 실제 설정을 DOM에 명시한 값이므로 ID 매핑 추정보다 신뢰도 높음.
        column_count = self._extract_column_count(element, classes)
        if column_count in (2, 3, 4):
            layout_type = {2: LayoutType.GRID_2_COLUMN,
                           3: LayoutType.GRID_3_COLUMN,
                           4: LayoutType.GRID_4_COLUMN}[column_count]

        # 텍스트 정렬 추출
        text_alignment = self._extract_text_alignment(element, classes)

        # 배경 정보 추출
        bg_type, bg_value = self._extract_background(element)

        # 내부 요소 파싱
        elements = self._parse_elements(element)

        return ParsedComponent(
            component_id=component_id,
            component_type=component_type,
            layout_type=layout_type,
            column_count=column_count,
            text_alignment=text_alignment,
            background_type=bg_type,
            background_value=bg_value,
            elements=elements
        )

    def _extract_column_count(self, element: Tag, classes: List[str]) -> int:
        """column-N 클래스에서 컬럼 수 추출 (컨테이너 자신 → 내부 캐러셀/그리드)."""
        pat = re.compile(r"\bcolumn-(\d)\b")
        m = pat.search(" ".join(classes))
        if m:
            return int(m.group(1))
        # 내부 요소(cmp-carousel swiper column-3 등) 탐색
        for el in element.select('[class*="column-"]'):
            cl = el.get("class", [])
            cl = " ".join(cl) if isinstance(cl, list) else str(cl)
            mm = pat.search(cl)
            if mm:
                return int(mm.group(1))
        return 0

    def _extract_text_alignment(self, element: Tag, classes: List[str]) -> TextAlignment:
        """텍스트 정렬 추출"""
        class_str = ' '.join(classes)

        # lg.com 실제 패턴: c-hero-banner--main-pos-left 등 'pos-*'가 텍스트 위치의 진실
        if 'pos-left' in class_str or 'align-left' in class_str or 'text-left' in class_str:
            return TextAlignment.LEFT
        elif 'pos-right' in class_str or 'align-right' in class_str or 'text-right' in class_str:
            return TextAlignment.RIGHT
        elif 'pos-center' in class_str or 'align-center' in class_str or 'text-center' in class_str:
            return TextAlignment.CENTER

        # 내부 텍스트 컨테이너에서 확인
        text_container = element.find(class_=re.compile(r'c-text-contents'))
        if text_container:
            container_classes = text_container.get('class', [])
            if isinstance(container_classes, str):
                container_classes = container_classes.split()
            container_str = ' '.join(container_classes)

            if 'left' in container_str:
                return TextAlignment.LEFT
            elif 'right' in container_str:
                return TextAlignment.RIGHT
            elif 'center' in container_str:
                return TextAlignment.CENTER

        return TextAlignment.LEFT  # 기본값

    def _extract_background(self, element: Tag) -> tuple[str, Optional[str]]:
        """배경 정보 추출"""
        classes = element.get('class', [])
        if isinstance(classes, str):
            classes = classes.split()
        class_str = ' '.join(classes)

        # 배경색 클래스 확인
        bg_color_map = {
            'bg-white': '#FFFFFF',
            'bg-black': '#000000',
            'bg-gray': '#F8F8F8',
            'bg-dark': '#333333',
            'bg-default': '#F8F8F8',
            'bg-brightness': '#F8F8F8',
        }

        for bg_class, color in bg_color_map.items():
            if bg_class in class_str:
                return ('color', color)

        # 배경 이미지 확인
        style = element.get('style', '')
        bg_match = re.search(r'background-image:\s*url\([\'"]?([^\'"]+)[\'"]?\)', style)
        if bg_match:
            return ('image', bg_match.group(1))

        # picture 요소에서 배경 이미지 추출
        picture = element.find('picture', class_=re.compile(r'bg|background'))
        if picture:
            source = picture.find('source')
            img = picture.find('img')
            if source and source.get('srcset'):
                return ('image', source['srcset'].split(',')[0].strip().split()[0])
            elif img and img.get('src'):
                return ('image', img['src'])

        return ('color', '#FFFFFF')  # 기본값

    def _parse_elements(self, component: Tag) -> ComponentElement:
        """컴포넌트 내부 요소 파싱"""
        elements = ComponentElement()

        # 스펙 라벨/값 짝 파싱 — 평면 텍스트보다 먼저.
        # 여기서 소비한 요소는 텍스트 목록에서 빼야 라벨·값이 두 번 나오지 않는다.
        elements.specs, spec_consumed = self._parse_spec_pairs(component)

        # 항목 단위 그룹 (캐러셀 슬라이드/카드) — 텍스트와 이미지를 항목별로 묶는다
        elements.items, item_consumed = self._parse_item_groups(component, spec_consumed)

        # 텍스트 요소 파싱 — 항목에 속한 텍스트는 항목이 이미 갖고 있으므로 제외
        elements.texts = self._parse_text_elements(
            component, skip_ids=spec_consumed | item_consumed)

        # 미디어 요소 파싱 — 전수 이미지 인벤토리 유지를 위해 항목 이미지도 포함한다
        elements.media = self._parse_media_elements(component)

        # CTA 요소 파싱
        elements.ctas = self._parse_cta_elements(component)

        return elements

    # 항목 반복 시 인스턴스별로 붙는 상태 클래스 — 항목 동일성 판정에서 무시한다
    _VOLATILE_CLASS = re.compile(
        r'^(swiper-slide-|swiper-pagination|is-|js-|active$|selected$|current$)', re.I)

    def _parse_item_groups(self, component: Tag, skip_ids=None):
        """같은 모양으로 반복되는 항목(텍스트+이미지 동반)을 찾아 항목별로 묶는다.

        판정은 클래스 이름이 아니라 구조로 한다:
          · 형제 관계이고
          · 클래스 서명이 같고
          · 각자 텍스트 슬롯과 이미지를 함께 갖는
        요소가 2개 이상이면 그 묶음을 항목 단위로 본다.
        여러 후보가 있으면 가장 깊은(=가장 세분화된) 층을 고른다.

        반환: (ItemGroup 목록, 항목에 소비된 텍스트 요소 id 집합)
        """
        skip_ids = skip_ids or set()
        groups = {}
        for el in component.find_all(True):
            if el is component:
                continue
            if not el.find(class_=self.SLOT_PREFIX_RE):
                continue                       # 텍스트 슬롯 없음
            if not el.find(['img', 'picture', 'video']):
                continue                       # 이미지 없음
            parent = el.parent
            if parent is None:
                continue
            sig = (id(parent), el.name, ' '.join(sorted(
                c for c in (el.get('class') or []) if not self._VOLATILE_CLASS.match(c))))
            groups.setdefault(sig, []).append(el)

        best = None
        for els in groups.values():
            if len(els) < 2:
                continue
            depth = len(list(els[0].parents))
            if best is None or depth > best[0] or (depth == best[0] and len(els) > len(best[1])):
                best = (depth, els)
        if best is None:
            return [], set()

        items, consumed, seen_sig = [], set(), set()
        # 후보 항목 전체의 텍스트 슬롯을 소비 처리한다.
        # (PC/모바일 중복으로 걸러낸 항목의 슬롯까지 빼야 평면 텍스트에 잔여물이 남지 않는다)
        for el in best[1]:
            for t_el in el.find_all(class_=self.SLOT_PREFIX_RE):
                consumed.add(id(t_el))
        for el in best[1]:
            texts = self._parse_text_elements(el, skip_ids=skip_ids)
            media = self._parse_media_elements(el)
            if not texts or not media:
                continue                       # 텍스트·이미지 둘 다 있어야 항목
            # PC/모바일 이중 마크업으로 같은 항목이 두 번 잡히는 것 방지
            key = (texts[0].text.strip().lower()[:80],
                   (texts[1].text.strip().lower()[:80] if len(texts) > 1 else ''))
            if key in seen_sig:
                continue
            seen_sig.add(key)
            items.append(ItemGroup(texts=texts, media=media))

        if len(items) < 2:
            return [], set()
        return items, consumed

    # 스펙 항목 하나를 담는 컨테이너 (내부에 라벨 슬롯 + 값 슬롯을 함께 가짐)
    _SPEC_ITEM_RE = re.compile(
        r'(^|\s)(c-text-contents|c-compare-selling__item|c-specs__item|c-spec-item)(\s|$)', re.I)
    # 컨테이너 안에서 라벨 / 값을 가리키는 클래스
    _SPEC_LABEL_RE = re.compile(r'__(headline|spec-name|label|title|term)\b', re.I)
    _SPEC_VALUE_RE = re.compile(r'__(bodycopy|spec-desc|value|desc|description|data)\b', re.I)
    # 스펙 그룹 제목 (Key Specs 등)
    _SPEC_GROUP_RE = re.compile(r'__(group-head|group-title|category)\b', re.I)
    # 스펙 전용 컴포넌트 — 이 안에서는 dl/table도 스펙표로 취급한다
    SPEC_COMPONENT_IDS = ('PD0008', 'ST0035')

    # 스펙 영역 컨테이너 — 이 안에 있는 항목만 스펙 짝으로 본다.
    # (일반 콘텐츠 섹션도 '제목 1개 + 본문 1개' 구조라 영역 제한이 없으면 전부 스펙으로 오인한다)
    _SPEC_REGION_RE = re.compile(
        r'(^|\s)c-(specs|specs-summary|specs-dimensions|summary-info|compare-selling'
        r'|spec-table|tech-specs|product-spec)(--|__|\s|$)', re.I)

    def _parse_spec_pairs(self, component: Tag):
        """라벨/값이 한 컨테이너에 짝으로 들어있는 스펙 항목을 추출.

        LG 스펙 영역은 두 가지 마크업을 쓴다.
          · Summary   : <div class="c-text-contents item">
                          <div class="c-text-contents__headline">라벨</div>
                          <div class="c-text-contents__bodycopy">값</div>
          · Key Specs : <li class="c-compare-selling__item">
                          <div class="c-compare-selling__spec-name">라벨</div>
                          <div class="c-compare-selling__spec-desc">값</div>
        둘 다 "컨테이너 안에 라벨 슬롯과 값 슬롯이 하나씩" 이라는 공통 구조라
        이 조건으로 짝을 찾는다. dl/dt/dd, table tr 도 함께 지원.

        반환: (SpecPair 목록, 짝으로 소비한 요소 id 집합)
        """
        pairs: List[SpecPair] = []
        consumed = set()

        def add(label_el, value_el, group=None):
            label = self._element_text(label_el)
            value = self._element_text(value_el)
            if not label or not value or label == value:
                return False
            pairs.append(SpecPair(label=label, value=value, group=group or None))
            consumed.add(id(label_el))
            consumed.add(id(value_el))
            return True

        # ① BEM 컨테이너 방식 (Summary / Key Specs) — 스펙 영역 안에서만
        spec_regions = component.find_all(class_=self._SPEC_REGION_RE)
        for region in spec_regions:
            for item in region.find_all(class_=self._SPEC_ITEM_RE):
                labels = [e for e in item.find_all(class_=self._SPEC_LABEL_RE)
                          if not e.find(class_=self._SPEC_LABEL_RE)]
                values = [e for e in item.find_all(class_=self._SPEC_VALUE_RE)
                          if not e.find(class_=self._SPEC_VALUE_RE)]
                if len(labels) != 1 or len(values) != 1:
                    continue      # 라벨·값이 1:1이 아니면 스펙 항목이 아니다
                if id(labels[0]) in consumed or id(values[0]) in consumed:
                    continue      # 중첩 영역에서 두 번 잡히는 것 방지
                # 소속 그룹명 — 문서 순서상 바로 앞의 그룹 제목 ('Key Specs', 'All specs').
                # 같은 스펙 영역 안의 제목만 인정한다 (밖의 리뷰·배너 문구가 끌려오지 않게)
                g = item.find_previous(class_=self._SPEC_GROUP_RE)
                if g is not None and region not in g.parents:
                    g = None
                group = self._element_text(g) if g is not None else None
                add(labels[0], values[0], group)

        # ②③ dl / table 방식 — 스펙 영역 안이거나 스펙 컴포넌트일 때만.
        #     제한이 없으면 결제 안내(Klarna 할부표) 같은 일반 정의목록도 스펙으로 오인한다.
        cls = ' '.join(component.get('class') or [])
        is_spec_component = any(cid in cls for cid in self.SPEC_COMPONENT_IDS)
        tabular_scopes = spec_regions if not is_spec_component else [component]

        for scope in tabular_scopes:
            # ② 정의 목록 (dl > dt/dd)
            for dl in scope.find_all('dl'):
                for dt in dl.find_all('dt', recursive=True):
                    dd = dt.find_next_sibling('dd')
                    if dd is not None and id(dt) not in consumed:
                        add(dt, dd)

            # ③ 표 (tr > th/td 또는 td 2개)
            for tr in scope.find_all('tr'):
                cells = tr.find_all(['th', 'td'], recursive=False)
                if len(cells) == 2 and id(cells[0]) not in consumed:
                    add(cells[0], cells[1])

        # 라벨 중복 제거 (PC/모바일 이중 마크업) — 값이 달라도 라벨이 같으면 첫 짝만 남긴다
        seen, uniq = set(), []
        for p in pairs:
            key = (p.group or '', re.sub(r'\s+', ' ', p.label.lower()))
            if key in seen:
                continue
            seen.add(key)
            uniq.append(p)
        return uniq, consumed

    # 본문 텍스트를 담는 컨테이너 계열(BEM 블록). LG CMS는 같은 "본문" 자리를
    # 컴포넌트마다 다른 블록 이름으로 내보내므로 계열을 명시적으로 열거한다.
    # 제외 대상: c-button / c-media / c-tabs / c-footer / c-support / c-pop-msg (UI 크롬),
    #           c-product-item / c-list-item (크로스셀·프로모 카드).
    SLOT_FAMILIES = (
        'text-contents',     # 표준 본문 슬롯
        'region-header',     # 섹션 헤더 (FAQ/지원 등)
        'content-box',       # 이미지 위 오버레이 라벨 (ST0035 등)
        'folding',           # 아코디언 본문 래퍼
        'accordion',         # 아코디언 질문/답변
        'image-compare',     # 비교 슬라이더 라벨/주석
        'compare-image',
    )
    SLOT_PREFIX_RE = re.compile(
        r'c-(?:' + '|'.join(SLOT_FAMILIES) + r')__([a-z0-9\-]+)', re.I
    )

    # 래퍼 슬롯(inner / wrapper / container …)은 따로 열거하지 않는다.
    # "하위에 다른 슬롯을 품고 있으면 제외"라는 규칙이 래퍼를 자동으로 걸러내고,
    # 하위 슬롯이 없는 래퍼는 그 자체가 유일한 텍스트 보유자이므로 살려야 한다.

    # 콘텐츠가 아닌 슬롯 — 항상 제외. form-text는 재입고 알림 동의문,
    # button-text/item-text는 '펼치기'·'재생' 같은 UI 라벨, cta/link는 별도 파싱.
    SLOT_NOISE = {
        'form-text', 'form', 'cta', 'button', 'link',
        'button-text', 'item-text',
    }

    # 슬롯 이름이 담고 있는 키워드 → 역할. LG CMS는 같은 "본문" 자리를
    # bodycopy / interviewee-name / interviewee-info / subcopy 등 여러 이름으로 내보내므로,
    # 화이트리스트 방식이면 본문이 통째로 누락된다. 미지의 슬롯은 본문으로 취급한다.
    SLOT_ROLE_KEYWORDS = (
        ('eyebrow', 'eyebrow'),
        ('subheadline', 'subheadline'),
        ('subhead', 'subheadline'),
        ('head-text', 'headline'),      # c-accordion__head-text = FAQ 질문
        ('headline', 'headline'),
        ('title', 'headline'),
        ('disclaimer', 'disclaimer'),
        ('legal', 'disclaimer'),
        ('footnote', 'disclaimer'),
    )

    # 레거시(비-CCG) 마크업 폴백 — 표준 슬롯이 하나도 없을 때만 사용.
    # 접두사(c-, cmp-) / BEM 접미사(__headline)를 모두 허용하되 토큰 전체를 매칭해
    # 'c-text-contents__headline' 같은 표준 슬롯과 중복 매칭되지 않게 한다.
    LEGACY_ROLE_SELECTORS = (
        ('eyebrow', r'^[a-z-]*(__)?eyebrow$'),
        ('subheadline', r'^[a-z-]*(__)?subheadline$'),
        ('headline', r'^[a-z-]*(__)?(headline|title)$'),
        ('body_copy', r'^[a-z-]*(__)?(bodycopy|body-copy|description|text)$'),
        ('disclaimer', r'^[a-z-]*(__)?(disclaimer|legal)$'),
    )

    # 인라인 태그는 붙여 써야 한다 (Door-in-Door<sup>®</sup> → "Door-in-Door®")
    _INLINE_TAGS = ('sup', 'sub', 'b', 'strong', 'i', 'em', 'u', 'span', 'a', 'small', 'mark')

    # 본문 추출 시 통째로 걷어낼 버튼류 (c-button / cmp-button / c-icon-button …)
    _BUTTON_CLASS_RE = re.compile(r'(^|-)button(--|$|__)|c-print-area', re.I)

    @classmethod
    def _role_for_slot(cls, slot: str) -> str:
        s = slot.lower()
        for kw, role in cls.SLOT_ROLE_KEYWORDS:
            if kw in s:
                return role
        return 'body_copy'

    @classmethod
    def _element_text(cls, el: Tag) -> str:
        """블록 경계는 띄우고 인라인 태그는 붙여서 텍스트를 뽑는다."""
        import copy as _copy
        try:
            frag = _copy.copy(el)
            # 버튼/UI 라벨('인쇄', '펼치기')은 본문이 아니다 — CTA는 별도로 파싱한다
            for t in frag.find_all(['button', 'script', 'style']):
                t.decompose()
            for t in frag.find_all(class_=cls._BUTTON_CLASS_RE):
                t.decompose()
            for t in frag.find_all(cls._INLINE_TAGS):
                t.unwrap()
            frag.smooth()
            text = frag.get_text(' ', strip=True)
        except Exception:
            text = el.get_text(' ', strip=True)
        return re.sub(r'\s+', ' ', text).strip()

    def _parse_text_elements(self, component: Tag, skip_ids=None) -> List[TextElement]:
        """텍스트 요소 파싱 (CCG 슬롯 우선, 미지 슬롯은 본문으로 수용)

        skip_ids: 스펙 짝(label/value)으로 이미 소비된 요소 id — 중복 출력을 막는다.
        """
        texts = []
        skip_ids = skip_ids or set()

        # 1) CCG 표준 슬롯: c-text-contents__<슬롯> / c-region-header__<슬롯>
        slotted = []             # (el, slot, role)
        slot_ids = set()
        for el in component.find_all(class_=self.SLOT_PREFIX_RE):
            slot = None
            for cls_name in (el.get('class') or []):
                m = self.SLOT_PREFIX_RE.match(cls_name)
                if m:
                    slot = m.group(1).lower()
                    break
            if not slot or slot in self.SLOT_NOISE or id(el) in skip_ids:
                continue
            slotted.append((el, slot, self._role_for_slot(slot)))
            slot_ids.add(id(el))

        # 하위에 다른 슬롯을 품은 요소는 제외 — 그대로 읽으면 자식 텍스트가 통째로 중복된다.
        # (래퍼 슬롯이라도 하위 슬롯이 없으면 유일한 텍스트 보유자이므로 살린다)
        candidates = []
        for el, slot, role in slotted:
            if any(id(d) in slot_ids for d in el.find_all(True)):
                continue
            candidates.append((el, role))
        candidate_ids = set(slot_ids)

        # 2) 표준 슬롯이 전혀 없을 때만 레거시 클래스 폴백
        if not candidates:
            legacy = []
            for role, pattern in self.LEGACY_ROLE_SELECTORS:
                rx = re.compile(pattern, re.I)
                for el in component.find_all(class_=rx):
                    if id(el) in candidate_ids or id(el) in skip_ids:
                        continue
                    legacy.append((el, role))
                    candidate_ids.add(id(el))
            # 여기서도 다른 후보를 품은 상위 요소는 제외한다
            candidates = [
                (el, role) for el, role in legacy
                if not any(id(d) in candidate_ids for d in el.find_all(True))
            ]

        seen = set()
        for el, role in candidates:
            text = self._element_text(el)
            if not text:
                continue
            key = (role, text.lower()[:160])
            if key in seen:          # PC/모바일 이중 마크업으로 같은 문구가 두 번 잡힌다
                continue
            seen.add(key)

            font_desktop, font_mobile, font_weight = self._extract_font_info(el)
            texts.append(TextElement(
                role=role,
                text=text,
                font_size_desktop=font_desktop,
                font_size_mobile=font_mobile,
                font_weight=font_weight
            ))

        return texts

    def _extract_font_info(self, element: Tag) -> tuple[Optional[str], Optional[str], Optional[str]]:
        """폰트 정보 추출"""
        classes = element.get('class', [])
        if isinstance(classes, str):
            classes = classes.split()

        font_desktop = None
        font_mobile = None
        font_weight = None

        for cls in classes:
            match = self.FONT_SIZE_PATTERN.match(cls)
            if match:
                device = match.group(1)  # w (desktop) or m (mobile)
                weight = match.group(2)  # light, normal, semibold, bold
                size = match.group(3)    # 픽셀 값

                if device == 'w':
                    font_desktop = f"{size}px"
                else:
                    font_mobile = f"{size}px"

                if not font_weight:
                    weight_map = {
                        'light': '300',
                        'normal': '400',
                        'semibold': '600',
                        'bold': '700'
                    }
                    font_weight = weight_map.get(weight, '400')

        return font_desktop, font_mobile, font_weight

    @staticmethod
    def _is_ui_control_media(el: Tag) -> bool:
        """탭 버튼·버튼·앵커(#) 링크 안의 이미지 = 콘텐츠를 고르거나 해당 위치로 이동시키는 UI.

        ST0036(Feature Icon Tab)의 off/on 아이콘, ST0009 탭 썸네일처럼 실제 콘텐츠 이미지는
        탭 패널(role=tabpanel)에 따로 있으므로, 컨트롤 안의 이미지는 콘텐츠에서 제외한다.
        """
        if el.find_parent('button') or el.find_parent(attrs={'role': re.compile(r'^tab(list)?$')}):
            return True
        a = el.find_parent('a')
        return a is not None and (a.get('href') or '').strip().startswith('#')

    def _parse_media_elements(self, component: Tag) -> List[MediaElement]:
        """미디어 요소 파싱"""
        media_list = []

        # 이미지 파싱 (picture 태그 우선)
        pictures = component.find_all('picture')
        for picture in pictures:
            # 배경 이미지는 제외
            parent_classes = ' '.join(picture.parent.get('class', []) if picture.parent else [])
            if 'bg' in parent_classes or 'background' in parent_classes:
                continue
            if self._is_ui_control_media(picture):
                continue

            media = MediaElement(type='image')

            # Desktop 이미지 (media query로 구분)
            sources = picture.find_all('source')
            for source in sources:
                media_query = source.get('media', '')
                srcset = source.get('srcset', '')

                if srcset:
                    src = srcset.split(',')[0].strip().split()[0]
                    if 'min-width: 769' in media_query or 'min-width:769' in media_query:
                        media.src_desktop = src
                    elif 'max-width: 768' in media_query or 'max-width:768' in media_query:
                        media.src_mobile = src
                    elif not media.src_desktop:
                        media.src_desktop = src

            # img 태그에서 fallback
            img = picture.find('img')
            if img:
                media.alt = img.get('alt', '')
                if not media.src_desktop:
                    media.src_desktop = img.get('src')
                if not media.src_mobile:
                    media.src_mobile = img.get('data-mobile-src') or img.get('src')

            if media.src_desktop or media.src_mobile:
                media_list.append(media)

        # 단독 img 태그 (picture 내부가 아닌 것)
        imgs = component.find_all('img')
        for img in imgs:
            if img.find_parent('picture'):
                continue
            if self._is_ui_control_media(img):
                continue

            # 아이콘이나 작은 이미지 제외
            classes = ' '.join(img.get('class', []))
            if 'icon' in classes or 'logo' in classes:
                continue

            # 지연 로딩 대응: data-src / data-desktop-src 폴백, 더미 픽셀(data:) 제외
            src = img.get('src') or img.get('data-src') or img.get('data-desktop-src')
            if src and src.startswith('data:'):
                src = img.get('data-src') or img.get('data-desktop-src')
            if src:
                media_list.append(MediaElement(
                    type='image',
                    src_desktop=src,
                    src_mobile=img.get('data-mobile-src'),
                    alt=img.get('alt', '')
                ))

        # 비디오 파싱
        videos = component.find_all('video')
        for video in videos:
            source = video.find('source')
            src = source.get('src') if source else video.get('src')
            if src:
                media_list.append(MediaElement(
                    type='video',
                    src_desktop=src
                ))

        # YouTube/BrightCove iframe
        iframes = component.find_all('iframe')
        for iframe in iframes:
            src = iframe.get('src', '')
            if 'youtube' in src or 'youtu.be' in src:
                video_id = self._extract_youtube_id(src)
                media_list.append(MediaElement(
                    type='video',
                    video_id=video_id
                ))
            elif 'brightcove' in src:
                media_list.append(MediaElement(
                    type='video',
                    src_desktop=src
                ))

        return media_list

    def _extract_youtube_id(self, url: str) -> Optional[str]:
        """YouTube 비디오 ID 추출"""
        patterns = [
            r'youtube\.com/embed/([a-zA-Z0-9_-]+)',
            r'youtube\.com/watch\?v=([a-zA-Z0-9_-]+)',
            r'youtu\.be/([a-zA-Z0-9_-]+)'
        ]
        for pattern in patterns:
            match = re.search(pattern, url)
            if match:
                return match.group(1)
        return None

    def _parse_cta_elements(self, component: Tag) -> List[CTAElement]:
        """CTA 요소 파싱"""
        ctas = []

        # CTA 컨테이너 찾기
        cta_containers = component.find_all(class_=re.compile(r'c-cta|cta'))

        for container in cta_containers:
            # 버튼/링크 찾기
            links = container.find_all(['a', 'button'])
            for link in links:
                text = link.get_text(strip=True)
                if not text:
                    continue

                classes = ' '.join(link.get('class', []))

                # 버튼 타입 결정
                if 'primary' in classes or 'btn-primary' in classes:
                    cta_type = 'primary'
                elif 'secondary' in classes or 'btn-secondary' in classes:
                    cta_type = 'secondary'
                elif 'link' in classes or 'text-link' in classes:
                    cta_type = 'text_link'
                else:
                    # 스타일로 추정
                    cta_type = 'primary' if 'button' in link.name else 'text_link'

                ctas.append(CTAElement(
                    type=cta_type,
                    text=text,
                    href=link.get('href')
                ))

        return ctas

    def get_components_by_type(self, component_type: str) -> List[ParsedComponent]:
        """특정 타입의 컴포넌트 반환"""
        return [c for c in self.components if c.component_type == component_type]

    def get_component_by_id(self, component_id: str) -> Optional[ParsedComponent]:
        """특정 ID의 컴포넌트 반환"""
        for c in self.components:
            if c.component_id == component_id:
                return c
        return None

    def to_json_serializable(self) -> List[Dict[str, Any]]:
        """JSON 직렬화 가능한 형태로 변환"""
        return [c.to_dict() for c in self.components]


def parse_html_components(html: str) -> List[Dict[str, Any]]:
    """
    HTML에서 CCG 컴포넌트를 파싱하는 헬퍼 함수

    Args:
        html: 파싱할 HTML 문자열

    Returns:
        파싱된 컴포넌트 딕셔너리 리스트
    """
    parser = ComponentParser(html)
    parser.parse_all()
    return parser.to_json_serializable()


# 테스트용 메인
if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) > 1:
        html_file = sys.argv[1]
        with open(html_file, 'r', encoding='utf-8') as f:
            html = f.read()

        components = parse_html_components(html)
        print(json.dumps(components, indent=2, ensure_ascii=False))
    else:
        print("Usage: python component_parser.py <html_file>")
