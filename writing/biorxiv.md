---
title: "How to download bioRxiv on a budget"
---

# 🔶 [Scientific Interface & Tooling Lab](../)
## How to download bioRxiv on a budget

bioRxiv hosts a S3 bucket containing all deposited preprint articles. This bucket is "requester pays" which unfortunately means you'll be paying $0.09 per GB downloaded. As the entire bucket is ~6TB the total cost to download would be $500+. To avoid this we will first download the files to a machine hosted in EC2 (no egress) and then filter down the articles to plain-text before downloading. By keeping only the plain-text data we can massively reduce the size of the data to download affordably.

To download the data I used `i7ie.3xlarge` ($1.56/hour) which offers sufficient network and storage bandwidth to download at 2.5GB/s with 7.5TB of disk space.


### Downloading bioRxiv to EC2

To efficiently download the thousands of compressed article files in parallel I used `s5cmd`:

```bash
s5cmd --request-payer requester cp --sp 's3://biorxiv-src-monthly/Current_Content/*' .
```

### Processing MECA Files

Now we want to extract plaintext from the thousands of compressed (.meca) files each corresponding to a different article. Thankfully the bioRxiv team have already preprocessed the PDF's into XML files containing plaintext! Now all we need to do is extract the XML file and delete the remaining contents

First we can create a function to process each MECA archive file:
```bash
process_meca() {
    meca="$1"
    id=$(basename "$meca" .meca)
    mkdir -p "xml/$id" 2>/dev/null
    unzip -qq -j "$meca" "content/*.xml" -d "xml/$id" < /dev/null 2>/dev/null
}
export -f process_meca
```

And then we can break up the processing to operate on one subdirectory at a time to avoid hitting system limits:

```bash
for dir in */; do
    find "$dir" -name "*.meca" -print0 | parallel -0 --progress --jobs $(($(nproc) * 2)) process_meca
done
```

Finally let's flatten our directory structure so we have all XML files in one top directory.

```bash
for d in xml/*/; do
    prefix=$(basename "$d")
    for f in "$d"*.xml; do
        if [ -f "$f" ]; then
            mv "$f" "xml/$prefix-$(basename "$f")"
        fi
    done
    rmdir "$d"
done
```

### Recompression

To reduce the download costs we can compress the directory of XML's ready to download to our local machine with scp.

```bash
tar cf - xml/ | zstd -T0 > biorxiv_text.tar.zst
```

This final file `biorxiv_text.tar.zst` is only 7GB which costs only $0.63 to download. Conveniently this entire process can be repeated for medrxiv - just change the s3 endpoint: "s3://biorxiv-src-monthly" -> "s3://medrxiv-src-monthly".

If you don't want to go through all of this yourself [I've uploaded the plain-text content of both biorxiv+medrxiv up to Dec 2024](https://drive.google.com/drive/folders/1yV9Zw6vNfyiVP68I5VxYUtVRlJkfzaB1?usp=sharing)