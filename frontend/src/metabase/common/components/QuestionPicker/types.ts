import type {
  CardId,
  ListCollectionItemsRequest,
  SearchModel,
} from "metabase-types/api";

import type {
  CollectionItemId,
  CollectionPickerItem,
} from "../CollectionPicker";
import type {
  EntityPickerModalOptions,
  ListProps,
  PickerState,
} from "../EntityPicker";

export type QuestionPickerModel = Extract<
  CollectionPickerItem["model"],
  "card" | "dataset" | "collection"
>;
export type QuestionPickerValueModel = Extract<
  CollectionPickerItem["model"],
  "card" | "dataset"
>;

export type QuestionPickerValueItem = CollectionPickerItem & {
  id: CardId;
  model: QuestionPickerValueModel;
};

// we could tighten this up in the future, but there's relatively little value to it
export type QuestionPickerItem = CollectionPickerItem;
export type QuestionPickerValue = Pick<QuestionPickerItem, "id" | "model">;

export type QuestionPickerOptions = EntityPickerModalOptions & {
  showPersonalCollections?: boolean;
  showRootCollection?: boolean;
};

export type QuestionItemListProps = ListProps<
  CollectionItemId,
  SearchModel,
  QuestionPickerItem,
  ListCollectionItemsRequest,
  QuestionPickerOptions
>;

export type QuestionPickerStatePath = PickerState<
  QuestionPickerItem,
  ListCollectionItemsRequest
>;
